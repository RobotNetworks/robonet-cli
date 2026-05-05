import { requireAgent } from "../auth.js";
import type { SessionService } from "../domain/sessions.js";
import { BadRequestError } from "../errors.js";
import { assertHandle } from "../handles.js";
import type { OperatorRepository } from "../storage/repository.js";
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
 * is the implicit perspective for any eligibility filtering. Currently
 * exposes `GET /search/messages` only; agent/directory search remain
 * hosted-only per the operator-layer split.
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
