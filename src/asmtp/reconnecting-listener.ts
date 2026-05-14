import { RobotNetCLIError, TransientAuthError } from "../errors.js";
import { startAsmtpListener, type AsmtpListenerOptions } from "./listener.js";
import type { ServerFrame } from "./types.js";

/**
 * Maximum number of distinct envelope ids the dedup gate remembers.
 *
 * Live push is at-least-once: a flapping connection or REST catch-up can
 * deliver the same envelope to the client more than once around a
 * reconnect. Receivers are responsible for dedup on `envelope_id`. This
 * LRU is the gate.
 *
 * 5000 sized to comfortably cover the catch-up-vs-live race window on
 * every reconnect plus bursts of inbound traffic without unbounded growth.
 */
const DEDUP_LRU_MAX = 5000;

/**
 * Why the listener gave up. Lets the caller render a meaningful exit summary
 * without re-classifying the error itself.
 *
 * - `permanent_resolve_error`: the connection resolver (auth + credential
 *   lookup) threw something that won't be fixed by retrying — typically a
 *   missing agent credential or a fatal auth-server response.
 * - `max_attempts_exhausted`: the configured `maxAttempts` cap was hit on
 *   transient WebSocket-level failures.
 */
export type TerminalFailureReason =
  | "permanent_resolve_error"
  | "max_attempts_exhausted";

export interface TerminalFailure {
  readonly reason: TerminalFailureReason;
  readonly error: Error;
  readonly attempts: number;
}

/**
 * Resolve a fresh `(wsUrl, token)` pair for each connection attempt.
 *
 * Called on the initial connect AND on every reconnect. This is what lets
 * the listener pick up a renewed bearer transparently — the auth-resolver
 * lazily re-mints `oauth_client_credentials` tokens when they're within the
 * grace window of expiry.
 */
export type AsmtpConnectionResolver = () => Promise<{
  readonly wsUrl: string;
  readonly token: string;
}>;

export interface ReconnectingListenerOptions {
  readonly resolve: AsmtpConnectionResolver;

  readonly onOpen?: () => void;
  readonly onFrame?: NonNullable<AsmtpListenerOptions["onFrame"]>;
  readonly onUnparseable?: NonNullable<AsmtpListenerOptions["onUnparseable"]>;
  readonly onError?: NonNullable<AsmtpListenerOptions["onError"]>;
  readonly onClose?: NonNullable<AsmtpListenerOptions["onClose"]>;

  /** Fired before each reconnect attempt with `(attempt, delayMs)`. Attempt is 1-indexed. */
  readonly onReconnectScheduled?: (attempt: number, delayMs: number) => void;

  /**
   * Fired exactly once when the listener stops trying — either because
   * `resolve()` threw a permanent error or because `maxAttempts` was hit.
   * After this fires, no further reconnects are scheduled and the listener
   * will not auto-recover.
   */
  readonly onTerminalFailure?: (failure: TerminalFailure) => void;

  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
  /** Backoff resets to `initialDelayMs` after a successful connection stays open this long. */
  readonly resetAfterStableMs?: number;
  /** Cap on reconnect attempts. Default: unbounded — listeners are daemon-like. */
  readonly maxAttempts?: number;
  /** Multiplicative jitter applied to each delay (e.g. 0.3 = ±30%). */
  readonly jitterRatio?: number;
}

export interface ReconnectingListener {
  /** Stop the listener; cancels any pending reconnect, closes any active socket, and disables future reconnects. */
  close(): void;
}

/**
 * A listener that survives transient WebSocket drops by reconnecting with
 * exponential backoff + jitter.
 *
 * Strategy: each successive failure doubles the delay (capped by
 * `maxDelayMs`); a connection that stays open longer than
 * `resetAfterStableMs` resets the attempt counter so a brief reconnect
 * after a long-stable session doesn't get punished.
 *
 * Tokens are re-resolved on every attempt — `auth-resolver` will re-mint
 * an expired `oauth_client_credentials` bearer transparently, so the
 * listener picks up fresh credentials without the user re-running login.
 *
 * Errors thrown from `resolve()` are classified before deciding whether to
 * retry: anything tagged {@link TransientAuthError} backs off and tries
 * again, and any other {@link RobotNetCLIError} subclass is treated as
 * permanent (missing credential, fatal auth failure, malformed config).
 * Permanent errors fire {@link ReconnectingListenerOptions.onTerminalFailure}
 * and stop the loop; supervisors then know to surface the error rather
 * than wait for an eventual recovery that will not come.
 *
 * Envelope-id dedup: live push is at-least-once. The listener tracks the
 * last {@link DEDUP_LRU_MAX} envelope/monitor-fact ids it forwarded to
 * `onFrame` and drops duplicates before they reach the caller.
 */
export function startReconnectingAsmtpListener(
  opts: ReconnectingListenerOptions,
): ReconnectingListener {
  const initialDelayMs = opts.initialDelayMs ?? 1_000;
  const maxDelayMs = opts.maxDelayMs ?? 30_000;
  const resetAfterStableMs = opts.resetAfterStableMs ?? 60_000;
  const maxAttempts = opts.maxAttempts ?? Number.POSITIVE_INFINITY;
  const jitterRatio = opts.jitterRatio ?? 0.3;

  let attempt = 0;
  let active: { close(): void } | null = null;
  let stableTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  // Receiver-side dedup gate. Live push is at-least-once, so REST
  // catch-up + WS race and brief disconnects can deliver the same
  // envelope_id more than once. Tracking ids we've already surfaced
  // makes the perceived stream exactly-once.
  const seenIds = new Map<string, true>();
  const seeIdAndCheckDuplicate = (id: string): boolean => {
    if (seenIds.has(id)) {
      // LRU bump: re-insert so the key sits at the most-recently-used
      // end of the Map's insertion order.
      seenIds.delete(id);
      seenIds.set(id, true);
      return true;
    }
    seenIds.set(id, true);
    if (seenIds.size > DEDUP_LRU_MAX) {
      const oldest = seenIds.keys().next().value;
      if (oldest !== undefined) seenIds.delete(oldest);
    }
    return false;
  };

  const clearStable = (): void => {
    if (stableTimer !== null) {
      clearTimeout(stableTimer);
      stableTimer = null;
    }
  };
  const clearReconnect = (): void => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const fireTerminal = (
    reason: TerminalFailureReason,
    error: Error,
  ): void => {
    if (closed) return;
    closed = true;
    clearReconnect();
    clearStable();
    if (active !== null) {
      active.close();
      active = null;
    }
    opts.onTerminalFailure?.({ reason, error, attempts: attempt });
  };

  const computeDelay = (a: number): number => {
    if (a === 0) return 0;
    const base = Math.min(initialDelayMs * Math.pow(2, a - 1), maxDelayMs);
    const delta = (Math.random() * 2 - 1) * base * jitterRatio;
    return Math.max(0, Math.round(base + delta));
  };

  const tryConnect = (): void => {
    if (closed) return;
    const delay = computeDelay(attempt);
    if (attempt > 0) {
      opts.onReconnectScheduled?.(attempt, delay);
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void doConnect();
    }, delay);
  };

  const doConnect = async (): Promise<void> => {
    if (closed) return;

    let resolved: { readonly wsUrl: string; readonly token: string };
    try {
      resolved = await opts.resolve();
    } catch (rawErr) {
      const err = rawErr instanceof Error ? rawErr : new Error(String(rawErr));
      opts.onError?.(err);
      if (isPermanentResolveError(err)) {
        fireTerminal("permanent_resolve_error", err);
        return;
      }
      attempt += 1;
      if (attempt >= maxAttempts) {
        fireTerminal("max_attempts_exhausted", err);
        return;
      }
      tryConnect();
      return;
    }

    if (closed) return;

    active = startAsmtpListener({
      wsUrl: resolved.wsUrl,
      token: resolved.token,
      onOpen: () => {
        clearStable();
        stableTimer = setTimeout(() => {
          attempt = 0;
          stableTimer = null;
        }, resetAfterStableMs);
        opts.onOpen?.();
      },
      onFrame: (frame, raw) => {
        const id = dedupKeyFor(frame);
        if (id !== null && seeIdAndCheckDuplicate(id)) {
          return;
        }
        opts.onFrame?.(frame, raw);
      },
      onUnparseable: opts.onUnparseable,
      onError: opts.onError,
      onClose: (code, reason) => {
        clearStable();
        active = null;
        opts.onClose?.(code, reason);
        if (closed) return;
        attempt += 1;
        if (attempt >= maxAttempts) {
          fireTerminal(
            "max_attempts_exhausted",
            new Error(
              `connection closed (${code}${reason.length > 0 ? `: ${reason}` : ""})`,
            ),
          );
          return;
        }
        tryConnect();
      },
    });
  };

  void doConnect();

  return {
    close: (): void => {
      closed = true;
      clearReconnect();
      clearStable();
      if (active !== null) {
        active.close();
        active = null;
      }
    },
  };
}

/**
 * Compute the dedup key for a server frame. Envelope notifications dedupe
 * on `id`; monitor facts dedupe on `(envelope_id, recipient_handle, fact)`
 * because a single envelope can produce multiple distinct facts (stored,
 * bounced, expired) for the same recipient over its lifetime.
 */
function dedupKeyFor(frame: ServerFrame): string | null {
  if (frame.op === "envelope.notify") {
    return frame.id.length > 0 ? `env:${frame.id}` : null;
  }
  return `mon:${frame.envelope_id}:${frame.recipient_handle}:${frame.fact}`;
}

/**
 * Classify an error from the resolve callback. Any typed `RobotNetCLIError`
 * that isn't explicitly transient is treated as permanent — the listener
 * will stop retrying and surface it via `onTerminalFailure`. Plain
 * network/fetch errors fall through to transient so a flaky network or
 * brief auth-server blip doesn't kill the listener; they get the usual
 * backoff treatment.
 */
function isPermanentResolveError(err: Error): boolean {
  if (err instanceof TransientAuthError) return false;
  return err instanceof RobotNetCLIError;
}

/** Re-export the frame type aliases callers will need. */
export type { ServerFrame };
