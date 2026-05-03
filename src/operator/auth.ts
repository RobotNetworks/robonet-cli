import type { IncomingMessage } from "node:http";

import { UnauthorizedError } from "./errors.js";
import type { AgentsRepo } from "./storage/repository.js";
import type { AgentRecord } from "./storage/types.js";
import { safeHexEqual, sha256Hex } from "./tokens.js";

/**
 * Token verification helpers used by the route layer.
 *
 * Two flavors of bearer:
 *
 * - Admin: a single static token whose sha256 hash is configured at
 *   operator startup (passed in via `ROBOTNET_OPERATOR_ADMIN_TOKEN_HASH`).
 *   Grants access to the `/_admin/*` surface.
 * - Agent: per-agent bearers stored as sha256 hashes on the `agents` table.
 *   Grants access to that agent's `/sessions/*` and `/connect` surface.
 */

const BEARER_RE = /^Bearer\s+(.+)$/i;

/** Extract a bearer token from `Authorization: Bearer <token>`. Returns null if missing or malformed. */
export function extractBearer(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const match = BEARER_RE.exec(header.trim());
  return match === null ? null : match[1].trim();
}

/** Throws {@link UnauthorizedError} unless the request carries the admin bearer. */
export function requireAdmin(req: IncomingMessage, adminTokenHash: string): void {
  const token = extractBearer(req);
  if (token === null) throw new UnauthorizedError();
  const presented = sha256Hex(token);
  if (!safeHexEqual(presented, adminTokenHash)) {
    throw new UnauthorizedError("invalid admin bearer");
  }
}

/**
 * Resolve the agent identity behind a request's bearer token. Throws
 * {@link UnauthorizedError} for missing / unknown tokens; otherwise returns
 * the matching {@link AgentRecord}.
 */
export function requireAgent(req: IncomingMessage, agents: AgentsRepo): AgentRecord {
  const token = extractBearer(req);
  if (token === null) throw new UnauthorizedError();
  const agent = agents.byBearerHash(sha256Hex(token));
  if (agent === null) throw new UnauthorizedError("unknown agent bearer");
  return agent;
}

/**
 * Resolve an agent for a `/connect` WebSocket upgrade.
 *
 * Two equivalent inputs are accepted, in order: the standard
 * `Authorization: Bearer <token>` header (used by Python / native
 * clients that can set arbitrary headers on the upgrade request) and
 * `?token=<bearer>` on the query string (the fallback for browsers,
 * which can't set Authorization on `WebSocket()` constructors). The
 * header form takes precedence when both are present.
 *
 * Throws {@link UnauthorizedError} on missing or unknown bearer.
 */
export function requireAgentForUpgrade(
  req: IncomingMessage,
  url: URL,
  agents: AgentsRepo,
): AgentRecord {
  const header = extractBearer(req);
  const queryToken = url.searchParams.get("token");
  const token =
    header !== null
      ? header
      : queryToken !== null && queryToken.length > 0
        ? queryToken
        : null;
  if (token === null) {
    throw new UnauthorizedError(
      "missing bearer — pass Authorization header or ?token=<bearer> query param",
    );
  }
  const agent = agents.byBearerHash(sha256Hex(token));
  if (agent === null) throw new UnauthorizedError("unknown agent bearer");
  return agent;
}
