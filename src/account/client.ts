import { CapabilityNotSupportedError } from "../agents/errors.js";
import type { AgentResponse } from "../agents/types.js";
import { AspApiError } from "../asp/errors.js";
import { aspRequest } from "../asp/http.js";
import type { Handle } from "../asp/types.js";
import { assertValidHandle } from "../asp/handles.js";
import type {
  AccountResponse,
  AccountSessionsResponse,
  AgentCreate,
  AgentListResponse,
  AgentUpdate,
} from "./types.js";

/**
 * Typed client for the account-scoped (human-principal) surface on the
 * hosted RobotNet backend. Authenticates with the user-session bearer
 * resolved by `resolveUserToken` (Cognito or `robotnet login` PKCE); the
 * backend rejects agent-scoped OAuth at the dep boundary.
 *
 * Capability gating: routes the operator does not implement (the local
 * in-tree operator never exposes account-scoped routes; third-party
 * ASP-only operators likewise) surface as
 * {@link CapabilityNotSupportedError} rather than a raw HTTP error so
 * commands can show a clean "switch network" hint.
 */
export class AccountClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #networkName: string;

  constructor(baseUrl: string, token: string, networkName: string) {
    this.#baseUrl = baseUrl;
    this.#token = token;
    this.#networkName = networkName;
  }

  // ── /account (account profile read) ─────────────────────────────────────

  async getAccount(): Promise<AccountResponse> {
    return await this.#guarded("account show", async () =>
      aspRequest<AccountResponse>({
        baseUrl: this.#baseUrl,
        path: "/account",
        method: "GET",
        token: this.#token,
      }),
    );
  }

  // ── /agents (account-scoped collection) ─────────────────────────────────

  async listAgents(opts: ListAgentsOptions = {}): Promise<AgentListResponse> {
    const params = new URLSearchParams();
    if (opts.query !== undefined) params.set("q", opts.query);
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts.cursor !== undefined) params.set("cursor", opts.cursor);
    const qs = params.toString();
    return await this.#guarded("account agents list", async () =>
      aspRequest<AgentListResponse>({
        baseUrl: this.#baseUrl,
        path: qs.length > 0 ? `/agents?${qs}` : "/agents",
        method: "GET",
        token: this.#token,
      }),
    );
  }

  async listManagedAgents(): Promise<AgentListResponse> {
    return await this.#guarded("account agents list (managed)", async () =>
      aspRequest<AgentListResponse>({
        baseUrl: this.#baseUrl,
        path: "/agents/managed",
        method: "GET",
        token: this.#token,
      }),
    );
  }

  async createAgent(input: AgentCreate): Promise<AgentResponse> {
    return await this.#guarded("account agents new", async () =>
      aspRequest<AgentResponse>({
        baseUrl: this.#baseUrl,
        path: "/agents",
        method: "POST",
        token: this.#token,
        body: input,
      }),
    );
  }

  async updateAgent(handle: Handle, input: AgentUpdate): Promise<AgentResponse> {
    assertValidHandle(handle);
    return await this.#guarded("account agents set", async () =>
      aspRequest<AgentResponse>({
        baseUrl: this.#baseUrl,
        path: agentPath(handle),
        method: "PATCH",
        token: this.#token,
        body: input,
      }),
    );
  }

  async deleteAgent(handle: Handle): Promise<void> {
    assertValidHandle(handle);
    await this.#guarded("account agents rm", async () =>
      aspRequest<void>({
        baseUrl: this.#baseUrl,
        path: agentPath(handle),
        method: "DELETE",
        token: this.#token,
      }),
    );
  }

  // ── /accounts/me/sessions (account-aggregated session inbox) ────────────

  async listSessions(opts: ListSessionsOptions = {}): Promise<AccountSessionsResponse> {
    const params = new URLSearchParams();
    if (opts.state !== undefined) params.set("state", opts.state);
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts.cursor !== undefined) params.set("cursor", opts.cursor);
    const qs = params.toString();
    return await this.#guarded("account sessions", async () =>
      aspRequest<AccountSessionsResponse>({
        baseUrl: this.#baseUrl,
        path: qs.length > 0 ? `/accounts/me/sessions?${qs}` : "/accounts/me/sessions",
        method: "GET",
        token: this.#token,
      }),
    );
  }

  /**
   * Translate operator responses that signal an unimplemented account
   * surface into {@link CapabilityNotSupportedError}. 404 stays as-is so
   * domain-level "agent not found" or "session not found" surfaces with
   * the route's own error code; 405/501 means the operator simply does
   * not expose this route.
   */
  async #guarded<T>(capability: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (err) {
      if (
        err instanceof AspApiError &&
        (err.status === 405 || err.status === 501)
      ) {
        throw new CapabilityNotSupportedError(this.#networkName, capability);
      }
      throw err;
    }
  }
}

export interface ListAgentsOptions {
  readonly query?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ListSessionsOptions {
  readonly state?: "active" | "ended";
  readonly limit?: number;
  readonly cursor?: string;
}

function agentPath(handle: Handle): string {
  // Handle is already validated as `@<owner>.<name>` by assertValidHandle.
  // Use indexOf+slice rather than split(".", 2) — the latter limits the
  // result count rather than the split count, dropping trailing segments.
  const stripped = handle.slice(1);
  const dot = stripped.indexOf(".");
  if (dot < 0) {
    throw new Error(`agentPath: handle missing '.' separator: ${handle}`);
  }
  const owner = stripped.slice(0, dot);
  const name = stripped.slice(dot + 1);
  return `/agents/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}
