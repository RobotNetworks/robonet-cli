import type { WebSocket } from "ws";

import type { Handle } from "../storage/types.js";

/**
 * Per-handle presence state machine and live WebSocket connection registry.
 *
 * Tracks two things:
 *
 * - Connections. Multiple WS for the same handle are allowed; fan-out
 *   broadcasts to all of them.
 * - Presence transitions. When a handle's last connection closes the
 *   registry fires {@link Hooks.onWentOffline} immediately, starts a grace
 *   timer, and either cancels the timer + fires {@link Hooks.onCameBack}
 *   when a connection arrives within the window, or fires
 *   {@link Hooks.onGraceExpired} when it doesn't. Whitepaper §6.4 leaves
 *   exact disconnect handling operator-defined; this matches the
 *   reference operator's behavior.
 *
 * Hooks are intentionally callbacks rather than events so the service
 * layer can throw recoverable errors and the registry can choose whether
 * to swallow or surface them. We swallow today (with a stderr log) — the
 * operator should keep running even if a fan-out for a single handle's
 * presence transition fails.
 */
export interface PresenceHooks {
  readonly onWentOffline?: (handle: Handle) => void | Promise<void>;
  readonly onCameBack?: (handle: Handle) => void | Promise<void>;
  readonly onGraceExpired?: (handle: Handle) => void | Promise<void>;
}

export interface ConnectionRegistryOptions {
  /** Window after the last connection closes before {@link PresenceHooks.onGraceExpired} fires. Default 30000ms. */
  readonly graceMs?: number;
}

interface PresenceState {
  readonly connections: Set<WebSocket>;
  /** Set when in GRACE; null when ONLINE. */
  graceTimer: ReturnType<typeof setTimeout> | null;
}

export class ConnectionRegistry {
  readonly #connections = new Map<Handle, PresenceState>();
  readonly #graceMs: number;
  #hooks: PresenceHooks = {};
  #shuttingDown = false;

  constructor(opts: ConnectionRegistryOptions = {}) {
    this.#graceMs = opts.graceMs ?? 30_000;
  }

  /** Wire presence-transition callbacks. Replaces any prior hooks. */
  setHooks(hooks: PresenceHooks): void {
    this.#hooks = hooks;
  }

  /** Add `ws` under `handle` and arrange for it to be removed on close/error. */
  register(handle: Handle, ws: WebSocket): void {
    let state = this.#connections.get(handle);
    if (state === undefined) {
      state = { connections: new Set<WebSocket>(), graceTimer: null };
      this.#connections.set(handle, state);
    } else if (state.graceTimer !== null) {
      // Was in GRACE — we have a pending offline transition. Cancel it
      // and notify the service that the agent came back.
      clearTimeout(state.graceTimer);
      state.graceTimer = null;
      this.#fire("onCameBack", handle);
    }
    state.connections.add(ws);

    const cleanup = (): void => this.#unregister(handle, ws);
    ws.once("close", cleanup);
    ws.once("error", cleanup);
  }

  /** Number of agents currently online (≥1 connection, regardless of grace state). */
  get onlineHandleCount(): number {
    let n = 0;
    for (const state of this.#connections.values()) {
      if (state.connections.size > 0) n += 1;
    }
    return n;
  }

  /** True when at least one open connection exists for `handle`. */
  isOnline(handle: Handle): boolean {
    const state = this.#connections.get(handle);
    if (state === undefined) return false;
    for (const ws of state.connections) {
      if (ws.readyState === ws.OPEN) return true;
    }
    return false;
  }

  /**
   * Send `payload` (already-encoded JSON) to every open connection for
   * `handle`. Returns the count of connections the frame was queued onto.
   */
  send(handle: Handle, payload: string): number {
    const state = this.#connections.get(handle);
    if (state === undefined) return 0;
    let n = 0;
    for (const ws of state.connections) {
      if (ws.readyState === ws.OPEN) {
        ws.send(payload);
        n += 1;
      }
    }
    return n;
  }

  /**
   * Drop every connection — used during operator shutdown. Suppresses the
   * went-offline / grace-expired hooks so we don't write phantom
   * session.disconnected events on the way out.
   */
  closeAll(code: number, reason: string): void {
    this.#shuttingDown = true;
    for (const state of this.#connections.values()) {
      if (state.graceTimer !== null) {
        clearTimeout(state.graceTimer);
        state.graceTimer = null;
      }
      for (const ws of state.connections) {
        try {
          ws.close(code, reason);
        } catch {
          // best-effort
        }
      }
    }
    this.#connections.clear();
  }

  #unregister(handle: Handle, ws: WebSocket): void {
    const state = this.#connections.get(handle);
    if (state === undefined) return;
    state.connections.delete(ws);
    if (state.connections.size > 0) return;
    if (this.#shuttingDown) {
      // Don't emit went-offline during shutdown — the operator process is
      // tearing down and any session.disconnected events would persist
      // into a future startup with no peer to deliver them to.
      this.#connections.delete(handle);
      return;
    }
    // Last connection just closed. Notify the service immediately, then
    // start the grace timer that will promote them to "left" if they
    // don't come back.
    this.#fire("onWentOffline", handle);
    state.graceTimer = setTimeout(() => {
      // Re-check state under the timer — a connection may have been
      // re-added in the same tick; in that case `register` would have
      // cleared the timer and we wouldn't be here.
      const stillOffline = this.#connections.get(handle);
      if (stillOffline === undefined || stillOffline.connections.size > 0) return;
      stillOffline.graceTimer = null;
      this.#connections.delete(handle);
      this.#fire("onGraceExpired", handle);
    }, this.#graceMs);
    // The grace timer keeps the Node event loop alive until it fires.
    // unref() so the operator can exit cleanly during shutdown if a
    // grace window happens to be open.
    state.graceTimer.unref?.();
  }

  #fire(name: keyof PresenceHooks, handle: Handle): void {
    const hook = this.#hooks[name];
    if (hook === undefined) return;
    let result: void | Promise<void>;
    try {
      result = hook(handle);
    } catch (err) {
      this.#logHookError(name, handle, err);
      return;
    }
    if (result instanceof Promise) {
      result.catch((err: unknown) => this.#logHookError(name, handle, err));
    }
  }

  #logHookError(name: string, handle: Handle, err: unknown): void {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `robotnet-operator: presence hook ${name}(${handle}) failed: ${detail}\n`,
    );
  }
}
