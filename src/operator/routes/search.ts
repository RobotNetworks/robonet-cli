import { requireAgent } from "../auth.js";
import { BadRequestError } from "../errors.js";
import type { OperatorRepository } from "../storage/repository.js";
import type { AgentRecord } from "../storage/types.js";
import { sendJson } from "./json.js";
import type { Router } from "./router.js";

interface SearchRoutesContext {
  readonly repo: OperatorRepository;
}

/**
 * Register `/search/*` routes on `router`.
 *
 *  - `GET /search/agents` substring search over agents on this operator,
 *    visibility-filtered against the caller.
 *  - `GET /search` directory wrapper that aggregates agents (+ empty
 *    people/organisations arrays the in-tree operator has no analogue
 *    for; the CLI's directory render skips empty sections).
 *  - `GET /search/messages` substring search across the caller's own
 *    mailbox (envelopes the caller is a recipient of). Operator
 *    extension to ASMTP — not part of the open wire spec. The reference
 *    implementation here is a LIKE match against `subject` + the JSON-
 *    encoded body; production operators substitute a real text index.
 */
export function registerSearchRoutes(
  router: Router,
  ctx: SearchRoutesContext,
): void {
  router.add("GET", "/search/agents", (rc) => {
    const caller = requireAgent(rc.req, ctx.repo.agents);
    const query = parseQuery(rc.url);
    const limit = parseAgentSearchLimit(rc.url);
    const cursor = parseOptionalCursor(rc.url);
    const afterHandle = cursor !== undefined ? decodeCursor(cursor) : undefined;
    const candidates = ctx.repo.agents.searchPage({
      query,
      limit,
      ...(afterHandle !== undefined ? { afterHandle } : {}),
    });
    const visible = candidates.filter((a) => isVisibleTo(ctx, a, caller));
    const nextCursor =
      candidates.length === limit
        ? encodeCursor(candidates[candidates.length - 1]!.handle)
        : null;
    sendJson(rc.res, 200, {
      agents: visible.map(toAgentSearchResult),
      next_cursor: nextCursor,
    });
  });

  router.add("GET", "/search", (rc) => {
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

  router.add("GET", "/search/messages", (rc) => {
    const caller = requireAgent(rc.req, ctx.repo.agents);
    const query = parseQuery(rc.url);
    const limit = parseMessageSearchLimit(rc.url);
    const hits = ctx.repo.envelopes.searchForRecipient({
      recipientHandle: caller.handle,
      query,
      limit,
    });
    sendJson(rc.res, 200, {
      envelopes: hits.map((e) => ({
        envelope_id: e.id,
        sender_handle: e.fromHandle,
        recipient_handles: ctx.repo.mailbox.recipientsFor(e.id),
        subject: e.subject,
        snippet: null,
        created_at: e.createdAtMs,
        date_ms: e.dateMs,
      })),
    });
  });
}

function parseMessageSearchLimit(url: URL): number {
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

function isVisibleTo(
  ctx: SearchRoutesContext,
  target: AgentRecord,
  caller: AgentRecord,
): boolean {
  if (target.visibility === "public") return true;
  if (target.handle === caller.handle) return true;
  return ctx.repo.agents
    .listAllowlist(target.handle)
    .some(
      (row) =>
        row.entry === caller.handle || row.entry === ownerGlob(caller.handle),
    );
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

function parseOptionalCursor(url: URL): string | undefined {
  const v = url.searchParams.get("cursor");
  if (v === null || v.length === 0) return undefined;
  if (v.length > 200) {
    throw new BadRequestError("cursor too long", "INVALID_QUERY");
  }
  return v;
}

function encodeCursor(handle: string): string {
  return Buffer.from(handle, "utf-8").toString("base64url");
}

function decodeCursor(cursor: string): string {
  try {
    return Buffer.from(cursor, "base64url").toString("utf-8");
  } catch {
    throw new BadRequestError("malformed cursor", "INVALID_QUERY");
  }
}

