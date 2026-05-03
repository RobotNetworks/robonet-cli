import { startAspListener, type AspListenerOptions } from "./listener.js";
import type { SessionEvent, UnknownSessionEvent } from "./types.js";

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
 * No automatic distinction between recoverable and permanent failures
 * (e.g. 401 because the agent was deleted) — backoff just keeps going.
 * Operators see the repeated `onReconnectScheduled` notifications and
 * can Ctrl-C if they recognise the pattern.
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
    } catch (err) {
      opts.onError?.(err instanceof Error ? err : new Error(String(err)));
      attempt += 1;
      if (attempt >= maxAttempts) return;
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
      onEvent: opts.onEvent,
      onUnparseable: opts.onUnparseable,
      onError: opts.onError,
      onClose: (code, reason) => {
        clearStable();
        active = null;
        opts.onClose?.(code, reason);
        if (closed) return;
        attempt += 1;
        if (attempt >= maxAttempts) return;
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

/** Re-export the event-payload type aliases callers will need. */
export type { SessionEvent, UnknownSessionEvent };
