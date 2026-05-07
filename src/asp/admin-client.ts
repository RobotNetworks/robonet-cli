import { aspRequest } from "./http.js";
import type {
  AgentWire,
  AgentWithTokenWire,
  Handle,
  InboundPolicy,
} from "./types.js";

/**
 * Typed client for a local operator's network-management surface (`/_admin/*`).
 *
 * Authenticated by the per-network `local_admin_token` issued at
 * `robotnet network start`. Used by the unified `robotnet agent ...`
 * command group when the resolved network is local.
 *
 * Allowlist mutation is not on this client by design — under the actor
 * model, an agent's allowlist is self-owned and edited via
 * `robotnet me allowlist`, never by an admin reaching into someone else's
 * row. Inbound policy stays here because the local admin (= the user
 * running the operator) is permitted to enforce policy across agents on
 * their own network.
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

  listAgents(): Promise<readonly AgentWire[]> {
    return this.#get<{ agents: readonly AgentWire[] }>("/_admin/agents").then(
      (b) => b.agents,
    );
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
