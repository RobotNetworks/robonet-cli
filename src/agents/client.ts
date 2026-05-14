import { AsmtpApiError } from "../asmtp/errors.js";
import { asmtpRequest, asmtpTextRequest } from "../asmtp/http.js";
import type { AllowlistEntry, Handle } from "../asmtp/types.js";
import { assertValidAllowlistEntry, assertValidHandle } from "../asmtp/handles.js";
import { CapabilityNotSupportedError } from "./errors.js";
import type {
  AgentDetailResponse,
  AgentDirectorySearchResponse,
  AgentResponse,
  AgentSelfAllowlistResponse,
  AgentSelfUpdate,
  BlockListResponse,
  DirectorySearchResponse,
} from "./types.js";

/**
 * Typed client for the Robot Networks hosted agent-discovery surface.
 *
 * Wraps:
 *
 * - `GET /agents/me` and `PATCH /agents/me` — authed agent's own profile,
 *   authenticated with the calling agent's bearer.
 * - `GET /agents/{owner}/{name}` and `/card` — viewer-aware detail and card
 *   markdown for any handle. Some hosted deployments may not expose these to
 *   agent bearers yet; the guarded helpers below normalize that cleanly.
 * - `GET /search/agents` and `GET /search/directory` — already
 *   callable with an agent bearer.
 *
 * Capability gating: routes the operator does not implement surface as
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
      asmtpRequest<AgentResponse>({
        baseUrl: this.#baseUrl,
        path: "/agents/me",
        method: "GET",
        token: this.#token,
      }),
    );
  }

  async updateSelf(update: AgentSelfUpdate): Promise<AgentResponse> {
    return await this.#guarded("agent self update", async () =>
      asmtpRequest<AgentResponse>({
        baseUrl: this.#baseUrl,
        path: "/agents/me",
        method: "PATCH",
        token: this.#token,
        body: update,
      }),
    );
  }

  // ── self allowlist (agent-bearer) ───────────────────────────────────────

  async getSelfAllowlist(): Promise<AgentSelfAllowlistResponse> {
    return await this.#guarded("agent self allowlist list", async () =>
      asmtpRequest<AgentSelfAllowlistResponse>({
        baseUrl: this.#baseUrl,
        path: "/agents/me/allowlist",
        method: "GET",
        token: this.#token,
      }),
    );
  }

  async addSelfAllowlistEntries(
    entries: readonly AllowlistEntry[],
  ): Promise<AgentSelfAllowlistResponse> {
    for (const entry of entries) assertValidAllowlistEntry(entry);
    return await this.#guarded("agent self allowlist add", async () =>
      asmtpRequest<AgentSelfAllowlistResponse>({
        baseUrl: this.#baseUrl,
        path: "/agents/me/allowlist",
        method: "POST",
        token: this.#token,
        body: { entries },
      }),
    );
  }

  async removeSelfAllowlistEntry(
    entry: AllowlistEntry,
  ): Promise<AgentSelfAllowlistResponse> {
    assertValidAllowlistEntry(entry);
    return await this.#guarded("agent self allowlist remove", async () =>
      asmtpRequest<AgentSelfAllowlistResponse>({
        baseUrl: this.#baseUrl,
        path: `/agents/me/allowlist/${encodeURIComponent(entry)}`,
        method: "DELETE",
        token: this.#token,
      }),
    );
  }

  // ── self blocks (agent-bearer) ──────────────────────────────────────────

  async listBlocks(opts: { readonly limit?: number; readonly cursor?: string } = {}): Promise<BlockListResponse> {
    const params = new URLSearchParams();
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts.cursor !== undefined) params.set("cursor", opts.cursor);
    const qs = params.toString();
    return await this.#guarded("self blocks list", async () =>
      asmtpRequest<BlockListResponse>({
        baseUrl: this.#baseUrl,
        path: qs.length > 0 ? `/agents/me/blocks?${qs}` : "/agents/me/blocks",
        method: "GET",
        token: this.#token,
      }),
    );
  }

  async blockAgent(handle: Handle): Promise<void> {
    assertValidHandle(handle);
    await this.#guarded("self block", async () =>
      asmtpRequest<void>({
        baseUrl: this.#baseUrl,
        path: "/agents/me/blocks",
        method: "POST",
        token: this.#token,
        body: { handle },
      }),
    );
  }

  async unblockAgent(handle: Handle): Promise<void> {
    assertValidHandle(handle);
    // The hosted API accepts both handle and agent_id at this path; CLI users
    // type handles, so we forward the handle verbatim.
    await this.#guarded("self unblock", async () =>
      asmtpRequest<void>({
        baseUrl: this.#baseUrl,
        path: `/agents/me/blocks/${encodeURIComponent(handle)}`,
        method: "DELETE",
        token: this.#token,
      }),
    );
  }

  // ── any agent by handle ─────────────────────────────────────────────────

  async getAgent(handle: Handle): Promise<AgentDetailResponse> {
    assertValidHandle(handle);
    return await this.#guarded("agent detail", async () =>
      asmtpRequest<AgentDetailResponse>({
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
      asmtpTextRequest({
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
    cursor?: string,
  ): Promise<AgentDirectorySearchResponse> {
    return await this.#guardedSearch("agent search", async () =>
      asmtpRequest<AgentDirectorySearchResponse>({
        baseUrl: this.#baseUrl,
        path: searchPath("/search/agents", query, limit, cursor),
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
      asmtpRequest<DirectorySearchResponse>({
        baseUrl: this.#baseUrl,
        path: searchPath("/search", query, limit),
        method: "GET",
        token: this.#token,
      }),
    );
  }

  /**
   * Translate operator responses that signal an unimplemented agent/card/me
   * route into {@link CapabilityNotSupportedError}. 404 stays as-is for these
   * routes because the hosted API uses 404 as a privacy-preserving "not visible"
   * — only 405/501 are unambiguous capability gaps.
   */
  async #guarded<T>(capability: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (err) {
      if (
        err instanceof AsmtpApiError &&
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
        err instanceof AsmtpApiError &&
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

function searchPath(
  base: string,
  query: string,
  limit: number,
  cursor?: string,
): string {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  if (cursor !== undefined && cursor.length > 0) {
    params.set("cursor", cursor);
  }
  return `${base}?${params.toString()}`;
}
