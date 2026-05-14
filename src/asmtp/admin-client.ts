import { asmtpRequest } from "./http.js";
import type {
  AgentVisibility,
  AgentWire,
  AgentWithTokenWire,
  AllowlistEntry,
  Handle,
  InboundPolicy,
} from "./types.js";

/**
 * Normalize a raw `/_admin/agents` response.
 *
 * Older operators (and the in-tree stub) only populate `handle`, `policy`,
 * and `allowlist`; the profile fields (`display_name`, `visibility`,
 * `description`, `card_body`) may be absent. The TypeScript cast lies in
 * those cases and the renderer ends up printing `undefined` or crashing on
 * `.length` of an undefined string.
 *
 * Defaults match the contract in `types.ts`: handle as the display-name
 * fallback, `private` visibility, null prose fields.
 */
function normalizeAgentWire<T extends Record<string, unknown>>(raw: T): T & AgentWire {
  const handle = raw["handle"] as Handle;
  return {
    ...raw,
    handle,
    policy: (raw["policy"] as InboundPolicy | undefined) ?? "allowlist",
    allowlist:
      (raw["allowlist"] as readonly AllowlistEntry[] | undefined) ?? [],
    display_name: (raw["display_name"] as string | undefined) ?? handle,
    description: (raw["description"] as string | null | undefined) ?? null,
    card_body: (raw["card_body"] as string | null | undefined) ?? null,
    visibility: (raw["visibility"] as AgentVisibility | undefined) ?? "private",
  } as T & AgentWire;
}

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
 * Allowlist mutation is not on this client by design — an agent's allowlist
 * is self-owned and edited via `robotnet me allowlist`, never by an admin
 * reaching into someone else's row. Inbound policy stays here because the
 * local admin (= the user running the operator) is permitted to enforce
 * policy across agents on their own network.
 */
export class AdminClient {
  readonly #baseUrl: string;
  readonly #token: string;

  constructor(baseUrl: string, token: string) {
    this.#baseUrl = baseUrl;
    this.#token = token;
  }

  async registerAgent(
    handle: Handle,
    opts: AdminAgentRegisterInput = {},
  ): Promise<AgentWithTokenWire> {
    const raw = await this.#post<Record<string, unknown>>("/_admin/agents", {
      handle,
      ...(opts.policy !== undefined ? { policy: opts.policy } : {}),
      ...(opts.displayName !== undefined ? { display_name: opts.displayName } : {}),
      ...(opts.description !== undefined ? { description: opts.description } : {}),
      ...(opts.cardBody !== undefined ? { card_body: opts.cardBody } : {}),
      ...(opts.visibility !== undefined ? { visibility: opts.visibility } : {}),
    });
    return normalizeAgentWire(raw) as unknown as AgentWithTokenWire;
  }

  async listAgents(): Promise<readonly AgentWire[]> {
    const body = await this.#get<{ agents: readonly Record<string, unknown>[] }>(
      "/_admin/agents",
    );
    return body.agents.map(normalizeAgentWire);
  }

  async showAgent(handle: Handle): Promise<AgentWire> {
    const raw = await this.#get<Record<string, unknown>>(
      `/_admin/agents/${encodeURIComponent(handle)}`,
    );
    return normalizeAgentWire(raw);
  }

  removeAgent(handle: Handle): Promise<void> {
    return this.#delete<void>(`/_admin/agents/${encodeURIComponent(handle)}`);
  }

  async rotateToken(handle: Handle): Promise<AgentWithTokenWire> {
    const raw = await this.#post<Record<string, unknown>>(
      `/_admin/agents/${encodeURIComponent(handle)}/rotate-token`,
      undefined,
    );
    return normalizeAgentWire(raw) as unknown as AgentWithTokenWire;
  }

  /**
   * Apply a partial update to a local agent's profile and/or policy.
   * Each field is independently optional; passing none short-circuits
   * with the unchanged record.
   */
  async updateAgent(handle: Handle, input: AdminAgentUpdateInput): Promise<AgentWire> {
    const raw = await this.#patch<Record<string, unknown>>(
      `/_admin/agents/${encodeURIComponent(handle)}`,
      {
        ...(input.policy !== undefined ? { policy: input.policy } : {}),
        ...(input.displayName !== undefined ? { display_name: input.displayName } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.cardBody !== undefined ? { card_body: input.cardBody } : {}),
        ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
      },
    );
    return normalizeAgentWire(raw);
  }

  #get<T>(path: string): Promise<T> {
    return asmtpRequest<T>({
      baseUrl: this.#baseUrl,
      path,
      method: "GET",
      token: this.#token,
    });
  }

  #post<T>(path: string, body: unknown): Promise<T> {
    return asmtpRequest<T>({
      baseUrl: this.#baseUrl,
      path,
      method: "POST",
      token: this.#token,
      body,
    });
  }

  #patch<T>(path: string, body: unknown): Promise<T> {
    return asmtpRequest<T>({
      baseUrl: this.#baseUrl,
      path,
      method: "PATCH",
      token: this.#token,
      body,
    });
  }

  #delete<T>(path: string): Promise<T> {
    return asmtpRequest<T>({
      baseUrl: this.#baseUrl,
      path,
      method: "DELETE",
      token: this.#token,
    });
  }
}
