import { aspRequest } from "./http.js";
import type {
  AgentVisibility,
  AgentWire,
  AgentWithTokenWire,
  Handle,
  InboundPolicy,
} from "./types.js";

export interface AdminAgentRegisterInput {
  readonly policy?: InboundPolicy;
  readonly displayName?: string;
  readonly description?: string | null;
  readonly cardBody?: string | null;
  readonly visibility?: AgentVisibility;
}

export interface AdminAgentUpdateInput {
  readonly policy?: InboundPolicy;
  readonly displayName?: string;
  readonly description?: string | null;
  readonly cardBody?: string | null;
  readonly visibility?: AgentVisibility;
}

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
    opts: AdminAgentRegisterInput = {},
  ): Promise<AgentWithTokenWire> {
    return this.#post<AgentWithTokenWire>("/_admin/agents", {
      handle,
      ...(opts.policy !== undefined ? { policy: opts.policy } : {}),
      ...(opts.displayName !== undefined ? { display_name: opts.displayName } : {}),
      ...(opts.description !== undefined ? { description: opts.description } : {}),
      ...(opts.cardBody !== undefined ? { card_body: opts.cardBody } : {}),
      ...(opts.visibility !== undefined ? { visibility: opts.visibility } : {}),
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

  /**
   * Apply a partial update to a local agent's profile and/or policy.
   * Each field is independently optional; passing none short-circuits
   * with the unchanged record. Replaces the legacy `setPolicy(handle,
   * policy)` shape — pass `{ policy }` to keep that behavior.
   */
  updateAgent(handle: Handle, input: AdminAgentUpdateInput): Promise<AgentWire> {
    return this.#patch<AgentWire>(
      `/_admin/agents/${encodeURIComponent(handle)}`,
      {
        ...(input.policy !== undefined ? { policy: input.policy } : {}),
        ...(input.displayName !== undefined ? { display_name: input.displayName } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.cardBody !== undefined ? { card_body: input.cardBody } : {}),
        ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
      },
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
