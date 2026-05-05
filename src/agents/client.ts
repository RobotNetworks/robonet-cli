import { AspApiError } from "../asp/errors.js";
import { aspRequest, aspTextRequest } from "../asp/http.js";
import type { Handle } from "../asp/types.js";
import { assertValidHandle } from "../asp/handles.js";
import { CapabilityNotSupportedError } from "./errors.js";
import type {
  AgentDetailResponse,
  AgentDirectorySearchResponse,
  AgentResponse,
  AgentSelfUpdate,
  DirectorySearchResponse,
} from "./types.js";

/**
 * Typed client for the RobotNet hosted agent-discovery surface.
 *
 * Wraps:
 *
 * - `GET /agents/me` and `PATCH /agents/me` — authed agent's own profile,
 *   already accept agent-bearer auth (`ActingAgent`) on the backend.
 * - `GET /agents/{owner}/{name}` and `/card` — viewer-aware detail and card
 *   markdown for any handle. Currently `CurrentAccount`-only on the backend;
 *   the additive dual-auth rewire (so they accept agent-bearer too) is on
 *   `@backend.bot`'s track.
 * - `GET /search/agents` and `GET /search/directory` — already
 *   `ActingAgent`-callable.
 *
 * Capability gating: routes the operator does not implement (the local
 * in-tree operator, third-party ASP-only operators) surface as
 * {@link CapabilityNotSupportedError} rather than a raw HTTP error so
 * commands can show a clean network-switch hint. Per-route 404 semantics
 * differ — see the `#guarded*` helpers below.
 */
export class AgentDirectoryClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #networkName: string;

  constructor(baseUrl: string, token: string, networkName: string) {
    this.#baseUrl = baseUrl;
    this.#token = token;
    this.#networkName = networkName;
  }

  // ── self ─────────────────────────────────────────────────────────────────

  async getSelf(): Promise<AgentResponse> {
    return await this.#guarded("agent self detail", async () =>
      aspRequest<AgentResponse>({
        baseUrl: this.#baseUrl,
        path: "/agents/me",
        method: "GET",
        token: this.#token,
      }),
    );
  }

  async updateSelf(update: AgentSelfUpdate): Promise<AgentResponse> {
    return await this.#guarded("agent self update", async () =>
      aspRequest<AgentResponse>({
        baseUrl: this.#baseUrl,
        path: "/agents/me",
        method: "PATCH",
        token: this.#token,
        body: update,
      }),
    );
  }

  // ── any agent by handle ─────────────────────────────────────────────────

  async getAgent(handle: Handle): Promise<AgentDetailResponse> {
    assertValidHandle(handle);
    return await this.#guarded("agent detail", async () =>
      aspRequest<AgentDetailResponse>({
        baseUrl: this.#baseUrl,
        path: agentPath(handle),
        method: "GET",
        token: this.#token,
      }),
    );
  }

  async getAgentCard(handle: Handle): Promise<string> {
    assertValidHandle(handle);
    return await this.#guarded("agent card", async () =>
      aspTextRequest({
        baseUrl: this.#baseUrl,
        path: `${agentPath(handle)}/card`,
        token: this.#token,
      }),
    );
  }

  // ── search ──────────────────────────────────────────────────────────────

  async searchAgents(
    query: string,
    limit: number,
  ): Promise<AgentDirectorySearchResponse> {
    return await this.#guardedSearch("agent search", async () =>
      aspRequest<AgentDirectorySearchResponse>({
        baseUrl: this.#baseUrl,
        path: searchPath("/search/agents", query, limit),
        method: "GET",
        token: this.#token,
      }),
    );
  }

  async searchDirectory(
    query: string,
    limit: number,
  ): Promise<DirectorySearchResponse> {
    return await this.#guardedSearch("directory search", async () =>
      aspRequest<DirectorySearchResponse>({
        baseUrl: this.#baseUrl,
        path: searchPath("/search/directory", query, limit),
        method: "GET",
        token: this.#token,
      }),
    );
  }

  /**
   * Translate operator responses that signal an unimplemented agent/card/me
   * route into {@link CapabilityNotSupportedError}. 404 stays as-is for these
   * routes because the backend uses 404 as a privacy-preserving "not visible"
   * — only 405/501 are unambiguous capability gaps.
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

  /**
   * Search routes have no domain-level 404 (empty results return 200 with
   * empty arrays), so a 404 on `/search/*` unambiguously means "operator
   * doesn't expose this route" — translate to capability error.
   */
  async #guardedSearch<T>(capability: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (err) {
      if (
        err instanceof AspApiError &&
        (err.status === 404 || err.status === 405 || err.status === 501)
      ) {
        throw new CapabilityNotSupportedError(this.#networkName, capability);
      }
      throw err;
    }
  }
}

function agentPath(handle: Handle): string {
  // Handle is already validated as `@<owner>.<name>` by assertValidHandle.
  // Use indexOf+slice rather than split(".", 2): JS's split limits the
  // result count rather than the split count, so "@a.b.c" would silently
  // produce ["a", "b"] and lose the trailing segment if the handle pattern
  // ever loosens.
  const stripped = handle.slice(1);
  const dot = stripped.indexOf(".");
  if (dot < 0) {
    throw new Error(`agentPath: handle missing '.' separator: ${handle}`);
  }
  const owner = stripped.slice(0, dot);
  const name = stripped.slice(dot + 1);
  return `/agents/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

function searchPath(base: string, query: string, limit: number): string {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  return `${base}?${params.toString()}`;
}
