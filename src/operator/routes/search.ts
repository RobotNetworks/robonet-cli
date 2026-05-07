import { requireAgent } from "../auth.js";
import type { SessionService } from "../domain/sessions.js";
import { BadRequestError } from "../errors.js";
import { assertHandle } from "../handles.js";
import type { OperatorRepository } from "../storage/repository.js";
import type { AgentRecord } from "../storage/types.js";
import { sendJson } from "./json.js";
import type { Router } from "./router.js";

interface SearchRoutesContext {
  readonly repo: OperatorRepository;
  readonly service: SessionService;
}

/**
 * Register `/search/*` routes on `router`.
 *
 * Each route is bearer-auth'd via {@link requireAgent}; the calling agent
 * is the implicit perspective for any eligibility filtering. Exposes:
 *
 * - `GET /search/messages` — substring search over the calling agent's
 *   message inbox.
 * - `GET /search/agents` — substring search over agents on the network,
 *   visibility-filtered.
 */
export function registerSearchRoutes(router: Router, ctx: SearchRoutesContext): void {
  router.add("GET", "/search/messages", (rc) => {
    const agent = requireAgent(rc.req, ctx.repo.agents);
    const query = parseQuery(rc.url);
    const limit = parseLimit(rc.url);
    const sessionId = parseOptionalSessionId(rc.url);
    const counterpart = parseOptionalCounterpart(rc.url);
    const messages = ctx.service.searchMessages({
      caller: agent.handle,
      query,
      limit,
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(counterpart !== undefined ? { counterpartHandle: counterpart } : {}),
    });
    sendJson(rc.res, 200, { messages });
  });

  router.add("GET", "/search/agents", (rc) => {
    const caller = requireAgent(rc.req, ctx.repo.agents);
    const query = parseQuery(rc.url);
    const limit = parseAgentSearchLimit(rc.url);
    // Pull a wider window than `limit` so visibility filtering doesn't
    // truncate to fewer than the requested count when the first batch
    // contains private agents the caller can't see.
    const candidates = ctx.repo.agents.search(query, Math.min(limit * 4, 100));
    const visible = candidates
      .filter((a) => isVisibleTo(ctx, a, caller))
      .slice(0, limit);
    sendJson(rc.res, 200, {
      agents: visible.map(toAgentSearchResult),
    });
  });

  router.add("GET", "/search", (rc) => {
    // Directory search aggregates agents + people + organizations. The
    // local operator has no people or organization concept, so this
    // route is a thin agent-search wrapper that always returns empty
    // people/organizations arrays. The CLI's `robotnet search` uses
    // the same shape across both operators; consumers that only care
    // about agents can call `/search/agents` directly.
    const caller = requireAgent(rc.req, ctx.repo.agents);
    const query = parseQuery(rc.url);
    const limit = parseAgentSearchLimit(rc.url);
    const candidates = ctx.repo.agents.search(query, Math.min(limit * 4, 100));
    const visible = candidates
      .filter((a) => isVisibleTo(ctx, a, caller))
      .slice(0, limit);
    sendJson(rc.res, 200, {
      agents: visible.map(toAgentSearchResult),
      people: [],
      organizations: [],
    });
  });
}

function isVisibleTo(
  ctx: SearchRoutesContext,
  target: AgentRecord,
  caller: AgentRecord,
): boolean {
  if (target.visibility === "public") return true;
  if (target.handle === caller.handle) return true;
  return ctx.repo.agents
    .listAllowlist(target.handle)
    .some((row) => row.entry === caller.handle || row.entry === ownerGlob(caller.handle));
}

function ownerGlob(handle: string): string {
  const stripped = handle.startsWith("@") ? handle.slice(1) : handle;
  const dot = stripped.indexOf(".");
  return dot >= 0 ? `@${stripped.slice(0, dot)}.*` : handle;
}

function toAgentSearchResult(agent: AgentRecord): Record<string, unknown> {
  return {
    type: "agent",
    id: agent.handle,
    canonical_handle: agent.handle,
    display_name: agent.displayName,
    image_url: null,
  };
}

function parseAgentSearchLimit(url: URL): number {
  const v = url.searchParams.get("limit");
  if (v === null || v.length === 0) return 20;
  const n = Number.parseInt(v, 10);
  if (!Number.isInteger(n) || n < 1 || n > 50 || String(n) !== v) {
    throw new BadRequestError(
      "limit must be an integer between 1 and 50",
      "INVALID_QUERY",
    );
  }
  return n;
}

function parseQuery(url: URL): string {
  const v = url.searchParams.get("q");
  if (v === null || v.length === 0) {
    throw new BadRequestError("q is required", "INVALID_QUERY");
  }
  if (v.length < 2 || v.length > 100) {
    throw new BadRequestError(
      "q must be between 2 and 100 characters",
      "INVALID_QUERY",
    );
  }
  return v;
}

function parseLimit(url: URL): number {
  const v = url.searchParams.get("limit");
  if (v === null || v.length === 0) return 20;
  const n = Number.parseInt(v, 10);
  if (!Number.isInteger(n) || n < 1 || n > 100 || String(n) !== v) {
    throw new BadRequestError(
      "limit must be an integer between 1 and 100",
      "INVALID_QUERY",
    );
  }
  return n;
}

function parseOptionalSessionId(url: URL): string | undefined {
  const v = url.searchParams.get("session_id");
  if (v === null || v.length === 0) return undefined;
  if (!/^sess_[0-9A-Z]+$/.test(v)) {
    throw new BadRequestError(
      "session_id must be a session identifier",
      "INVALID_QUERY",
    );
  }
  return v;
}

function parseOptionalCounterpart(url: URL): string | undefined {
  const v = url.searchParams.get("counterpart");
  if (v === null || v.length === 0) return undefined;
  return assertHandle(v, "counterpart");
}
