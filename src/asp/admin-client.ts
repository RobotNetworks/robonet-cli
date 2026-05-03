import { aspRequest } from "./http.js";
import type {
  AgentWire,
  AgentWithTokenWire,
  AllowlistEntry,
  Handle,
  InboundPolicy,
} from "./types.js";

/**
 * Typed client for the network-management surface (`/_admin/*`).
 *
 * Exposes only the operations the RobotNet CLI surfaces to users:
 * register/show/remove/rotate-token/set-policy on a single agent, plus
 * allowlist add/remove. Admin-only operations that would expose every
 * agent or every event on the network — `list agents`, `reset`, the
 * event-tap WebSocket — are deliberately omitted; those belong in the
 * RobotNet web app, not the CLI.
 */
export class AspAdminClient {
  readonly #baseUrl: string;
  readonly #token: string;

  constructor(baseUrl: string, token: string) {
    this.#baseUrl = baseUrl;
    this.#token = token;
  }

  registerAgent(
    handle: Handle,
    opts: { readonly policy?: InboundPolicy } = {},
  ): Promise<AgentWithTokenWire> {
    return this.#post<AgentWithTokenWire>("/_admin/agents", {
      handle,
      ...(opts.policy !== undefined ? { policy: opts.policy } : {}),
    });
  }

  showAgent(handle: Handle): Promise<AgentWire> {
    return this.#get<AgentWire>(`/_admin/agents/${encodeURIComponent(handle)}`);
  }

  removeAgent(handle: Handle): Promise<void> {
    return this.#delete<void>(`/_admin/agents/${encodeURIComponent(handle)}`);
  }

  rotateToken(handle: Handle): Promise<AgentWithTokenWire> {
    return this.#post<AgentWithTokenWire>(
      `/_admin/agents/${encodeURIComponent(handle)}/rotate-token`,
      undefined,
    );
  }

  setPolicy(handle: Handle, policy: InboundPolicy): Promise<AgentWire> {
    return this.#patch<AgentWire>(
      `/_admin/agents/${encodeURIComponent(handle)}`,
      { policy },
    );
  }

  addToAllowlist(
    handle: Handle,
    entries: readonly AllowlistEntry[],
  ): Promise<AgentWire> {
    return this.#post<AgentWire>(
      `/_admin/agents/${encodeURIComponent(handle)}/allowlist`,
      { entries },
    );
  }

  removeFromAllowlist(
    handle: Handle,
    entry: AllowlistEntry,
  ): Promise<AgentWire> {
    return this.#delete<AgentWire>(
      `/_admin/agents/${encodeURIComponent(handle)}/allowlist/${encodeURIComponent(entry)}`,
    );
  }

  #get<T>(path: string): Promise<T> {
    return aspRequest<T>({
      baseUrl: this.#baseUrl,
      path,
      method: "GET",
      token: this.#token,
    });
  }

  #post<T>(path: string, body: unknown): Promise<T> {
    return aspRequest<T>({
      baseUrl: this.#baseUrl,
      path,
      method: "POST",
      token: this.#token,
      body,
    });
  }

  #patch<T>(path: string, body: unknown): Promise<T> {
    return aspRequest<T>({
      baseUrl: this.#baseUrl,
      path,
      method: "PATCH",
      token: this.#token,
      body,
    });
  }

  #delete<T>(path: string): Promise<T> {
    return aspRequest<T>({
      baseUrl: this.#baseUrl,
      path,
      method: "DELETE",
      token: this.#token,
    });
  }
}
