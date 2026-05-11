import { RobotNetCLIError, TransientAuthError } from "../errors.js";
import { startAspListener, type AspListenerOptions } from "./listener.js";
import type { SessionEvent, UnknownSessionEvent } from "./types.js";

/**
 * Maximum number of distinct ``event_id``s the dedup gate remembers.
 *
 * The wire is **at-least-once** (operator broadcasts and catchup replays
 * can both deliver the same event around a reconnect; SQS/SNS layers
 * underneath are also at-least-once by design). Receivers are responsible
 * for dedup on ``event_id``. This LRU is the gate.
 *
 * 5000 sized to comfortably cover:
 *  - The catchup-vs-live race window on every reconnect (typically a
 *    handful of envelopes per session × dozens of sessions).
 *  - SQS-level redelivery bursts.
 *  - Bursty fanout where one publish lands on multiple paths.
 *
 * Memory cost is negligible (~26-char ULIDs in a Map). The cap exists
 * only to prevent unbounded growth on a long-running listener.
 */
const DEDUP_LRU_MAX = 5000;

/**
 * Why the listener gave up. Lets the caller render a meaningful exit summary
 * to its supervisor without re-classifying the error itself.
 *
 * - `permanent_resolve_error`: the connection resolver (auth + credential
 *   lookup) threw something that won't be fixed by retrying — typically a
 *   missing agent credential or a fatal auth-server response. The user has
 *   to take action (re-login, register the agent, fix config) before any
 *   future retry can succeed.
 * - `max_attempts_exhausted`: the configured `maxAttempts` cap was hit on
 *   transient WebSocket-level failures. The underlying issue may resolve
 *   on its own (network blip, server restart) but we've stopped trying.
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
export type AspConnectionResolver = () => Promise<{
  readonly wsUrl: string;
  readonly token: string;
}>;

export interface ReconnectingListenerOptions {
  readonly resolve: AspConnectionResolver;

  readonly onOpen?: () => void;
  readonly onEvent?: NonNullable<AspListenerOptions["onEvent"]>;
  readonly onUnparseable?: NonNullable<AspListenerOptions["onUnparseable"]>;
  readonly onError?: NonNullable<AspListenerOptions["onError"]>;
  readonly onClose?: NonNullable<AspListenerOptions["onClose"]>;

  /** Fired before each reconnect attempt with `(attempt, delayMs)`. Attempt is 1-indexed. */
  readonly onReconnectScheduled?: (attempt: number, delayMs: number) => void;

  /**
   * Fired exactly once when the listener stops trying — either because
   * `resolve()` threw a permanent error or because `maxAttempts` was hit.
   * After this fires, no further reconnects are scheduled and the listener
   * will not auto-recover. Callers wire this up to render a final summary
   * and (typically) exit the process.
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
 * Permanent errors fire {@link onTerminalFailure} and stop the loop;
 * supervisors then know to surface the error rather than wait for an
 * eventual recovery that will not come.
 */
export function startReconnectingAspListener(
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

  // Receiver-side dedup gate. The wire is at-least-once: catchup replays
  // and live broadcasts can both deliver the same event around a
  // reconnect; SQS-level retries can also redeliver. Tracking event_ids
  // we've already surfaced to the caller's onEvent makes the perceived
  // stream exactly-once even though the operator never drops events.
  // State lives at the reconnecting-listener scope so dedup persists
  // across reconnects within one listener lifetime — events delivered
  // before a drop and replayed via catchup after the new connect get
  // filtered.
  const seenEventIds = new Map<string, true>();
  const seeEventIdAndCheckDuplicate = (eventId: string): boolean => {
    if (seenEventIds.has(eventId)) {
      // LRU bump: re-insert so it sits at the most-recently-used end.
      // The Map iteration order is insertion order; re-inserting moves
      // the key to the end without changing its presence.
      seenEventIds.delete(eventId);
      seenEventIds.set(eventId, true);
      return true;
    }
    seenEventIds.set(eventId, true);
    if (seenEventIds.size > DEDUP_LRU_MAX) {
      // Evict the oldest entry (insertion-order head of the Map).
      const oldest = seenEventIds.keys().next().value;
      if (oldest !== undefined) seenEventIds.delete(oldest);
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
      // Permanent failures (missing credential, fatal auth) won't be fixed
      // by waiting — bail out so the supervisor sees a terminal signal
      // instead of an infinite retry loop. TransientAuthError (5xx, 429,
      // request timeout from the auth server) and plain network/fetch
      // errors are still treated as transient.
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

    active = startAspListener({
      wsUrl: resolved.wsUrl,
      token: resolved.token,
      onOpen: () => {
        // Reset the attempt counter once we've been stably connected for a
        // while. Until then, a fast reconnect-then-drop should keep building
        // backoff so we don't hammer the server.
        clearStable();
        stableTimer = setTimeout(() => {
          attempt = 0;
          stableTimer = null;
        }, resetAfterStableMs);
        opts.onOpen?.();
      },
      onEvent: (event, raw) => {
        // Receiver-side dedup. The operator's wire is at-least-once,
        // so catchup-vs-live races and SQS redelivery can produce the
        // same event_id more than once. Drop the duplicate before it
        // reaches the caller so the perceived stream is exactly-once.
        const eventId = event.event_id;
        if (typeof eventId === "string" && eventId.length > 0) {
          if (seeEventIdAndCheckDuplicate(eventId)) {
            return;
          }
        }
        opts.onEvent?.(event, raw);
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
 * Classify an error from the resolve callback. Any typed `RobotNetCLIError`
 * that isn't explicitly transient is treated as permanent — the listener
 * will stop retrying and surface it via {@link onTerminalFailure}. Plain
 * network/fetch errors (anything not in the CLI error hierarchy) fall
 * through to transient so a flaky network or brief auth-server blip doesn't
 * kill the listener; they get the usual backoff treatment.
 *
 * The rule lives here (not in `errors.ts`) because the classification is
 * the reconnecting-listener's retry policy, not a property of the errors.
 */
function isPermanentResolveError(err: Error): boolean {
  if (err instanceof TransientAuthError) return false;
  return err instanceof RobotNetCLIError;
}

/** Re-export the event-payload type aliases callers will need. */
export type { SessionEvent, UnknownSessionEvent };
