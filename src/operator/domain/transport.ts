import type { WebSocket } from "ws";

import type { Handle } from "../storage/types.js";

/**
 * In-process WebSocket registry for the operator's `/connect` push surface.
 *
 * Multiple connections per handle are allowed; fan-out broadcasts to all
 * of them. There is no presence model — the wire is pure server push and
 * the client never declares "I'm here." Connections are added on upgrade
 * and removed on close/error.
 */
export class ConnectionRegistry {
  readonly #connections = new Map<Handle, Set<WebSocket>>();
  #shuttingDown = false;

  register(handle: Handle, ws: WebSocket): void {
    let set = this.#connections.get(handle);
    if (set === undefined) {
      set = new Set<WebSocket>();
      this.#connections.set(handle, set);
    }
    set.add(ws);

    const cleanup = (): void => this.#unregister(handle, ws);
    ws.once("close", cleanup);
    ws.once("error", cleanup);
  }

  get onlineHandleCount(): number {
    let n = 0;
    for (const set of this.#connections.values()) {
      if (set.size > 0) n += 1;
    }
    return n;
  }

  isOnline(handle: Handle): boolean {
    const set = this.#connections.get(handle);
    if (set === undefined) return false;
    for (const ws of set) {
      if (ws.readyState === ws.OPEN) return true;
    }
    return false;
  }

  /**
   * Send `payload` (already-encoded JSON) to every open connection for
   * `handle`. Returns the count of connections the frame was queued onto.
   */
  send(handle: Handle, payload: string): number {
    const set = this.#connections.get(handle);
    if (set === undefined) return 0;
    let n = 0;
    for (const ws of set) {
      if (ws.readyState === ws.OPEN) {
        ws.send(payload);
        n += 1;
      }
    }
    return n;
  }

  /** Drop every connection. Used during operator shutdown. */
  closeAll(code: number, reason: string): void {
    this.#shuttingDown = true;
    for (const set of this.#connections.values()) {
      for (const ws of set) {
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
    const set = this.#connections.get(handle);
    if (set === undefined) return;
    set.delete(ws);
    if (set.size === 0) this.#connections.delete(handle);
    void this.#shuttingDown;
  }
}
