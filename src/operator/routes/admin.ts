import type { DatabaseSync } from "node:sqlite";

import { requireAdmin } from "../auth.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../errors.js";
import { assertHandle } from "../handles.js";
import type { OperatorRepository } from "../storage/repository.js";
import type {
  AgentRecord,
  AgentVisibility,
  AllowlistEntry as AllowlistRow,
  Handle,
  InboundPolicy,
} from "../storage/types.js";
import { mintBearerToken, sha256Hex } from "../tokens.js";
import { parseJsonBody, sendJson, sendNoContent } from "./json.js";
import type { Router, RouteContext } from "./router.js";

/** Wire shape for an agent — mirrors the asp reference operator. The bearer
 * token is included only on register / rotate-token responses (we hash on
 * write so it's not recoverable on subsequent reads). Profile fields
 * (display_name, description, card_body, visibility) carry the v3-schema
 * agent metadata. */
interface AgentResponse {
  readonly handle: Handle;
  readonly token?: string;
  readonly policy: InboundPolicy;
  readonly allowlist: readonly string[];
  readonly display_name: string;
  readonly description: string | null;
  readonly card_body: string | null;
  readonly visibility: AgentVisibility;
}

interface AdminContext {
  readonly repo: OperatorRepository;
  readonly db: DatabaseSync;
  readonly adminTokenHash: string;
}

/**
 * Register `/_admin/*` routes on `router`.
 *
 * All admin routes require the admin bearer (verified via
 * {@link requireAdmin}). Errors are typed {@link OperatorError} subclasses
 * that the route layer's error boundary maps to JSON error envelopes.
 */
export function registerAdminRoutes(router: Router, ctx: AdminContext): void {
  const guard = (handler: (rc: RouteContext) => unknown | Promise<unknown>) => {
    return async (rc: RouteContext): Promise<void> => {
      requireAdmin(rc.req, ctx.adminTokenHash);
      const result = await handler(rc);
      if (result === undefined) return; // handler already responded
    };
  };

  router.add("POST", "/_admin/agents", guard(async (rc) => {
    const body = await parseJsonBody(rc.req);
    const handle = assertHandle(body.handle);
    const policy = parseOptionalPolicy(body.policy);
    const profile = parseProfileFields(body);

    if (ctx.repo.agents.byHandle(handle) !== null) {
      throw new ConflictError(`agent ${handle} already exists`, "AGENT_EXISTS");
    }

    const token = mintBearerToken();
    let agent: AgentRecord;
    try {
      agent = ctx.repo.agents.register({
        handle,
        bearerTokenHash: sha256Hex(token),
        ...(policy !== undefined ? { inboundPolicy: policy } : {}),
        ...(profile.displayName !== undefined ? { displayName: profile.displayName } : {}),
        ...(profile.description !== undefined ? { description: profile.description } : {}),
        ...(profile.cardBody !== undefined ? { cardBody: profile.cardBody } : {}),
        ...(profile.visibility !== undefined ? { visibility: profile.visibility } : {}),
      });
    } catch (err) {
      // sha256 hex collisions are infeasible; the only realistic UNIQUE
      // failure is two concurrent registers racing past the byHandle check.
      if (isUniqueViolation(err)) {
        throw new ConflictError(`agent ${handle} already exists`, "AGENT_EXISTS");
      }
      throw err;
    }
    sendJson(rc.res, 201, serializeAgent(ctx.repo, agent, { includeToken: token }));
  }));

  router.add("GET", "/_admin/agents", guard((rc) => {
    const agents = ctx.repo.agents.list().map((a) => serializeAgent(ctx.repo, a));
    sendJson(rc.res, 200, { agents });
  }));

  router.add("GET", "/_admin/agents/:handle", guard((rc) => {
    const agent = requireExistingAgent(ctx.repo, rc.params.handle);
    sendJson(rc.res, 200, serializeAgent(ctx.repo, agent));
  }));

  router.add("DELETE", "/_admin/agents/:handle", guard((rc) => {
    const handle = assertHandle(rc.params.handle, "path handle");
    if (!ctx.repo.agents.remove(handle)) {
      throw new NotFoundError(`agent ${handle} not found`);
    }
    sendNoContent(rc.res);
  }));

  router.add("POST", "/_admin/agents/:handle/rotate-token", guard((rc) => {
    const agent = requireExistingAgent(ctx.repo, rc.params.handle);
    const token = mintBearerToken();
    ctx.repo.agents.rotateBearerHash(agent.handle, sha256Hex(token));
    const fresh = ctx.repo.agents.byHandle(agent.handle);
    if (fresh === null) {
      // Vanishing between rotate + re-read indicates a concurrent delete.
      throw new NotFoundError(`agent ${agent.handle} not found`);
    }
    sendJson(rc.res, 200, serializeAgent(ctx.repo, fresh, { includeToken: token }));
  }));

  router.add("PATCH", "/_admin/agents/:handle", guard(async (rc) => {
    const agent = requireExistingAgent(ctx.repo, rc.params.handle);
    const body = await parseJsonBody(rc.req);
    const policy = parseOptionalPolicy(body.policy);
    const profile = parseProfileFields(body);
    let updated = agent;
    if (policy !== undefined) {
      ctx.repo.agents.setInboundPolicy(agent.handle, policy);
      updated = ctx.repo.agents.byHandle(agent.handle) ?? agent;
    }
    if (
      profile.displayName !== undefined ||
      profile.description !== undefined ||
      profile.cardBody !== undefined ||
      profile.visibility !== undefined
    ) {
      const result = ctx.repo.agents.updateProfile(agent.handle, {
        ...(profile.displayName !== undefined ? { displayName: profile.displayName } : {}),
        ...(profile.description !== undefined ? { description: profile.description } : {}),
        ...(profile.cardBody !== undefined ? { cardBody: profile.cardBody } : {}),
        ...(profile.visibility !== undefined ? { visibility: profile.visibility } : {}),
      });
      updated = result ?? updated;
    }
    sendJson(rc.res, 200, serializeAgent(ctx.repo, updated));
  }));

  // No third-party allowlist edit routes by design: an agent's allowlist
  // is self-owned and edited via `POST /allowlist` / `DELETE /allowlist/{entry}`
  // with the agent's own bearer (see src/operator/routes/self.ts). The
  // local admin's authority over the network does not extend to reaching
  // into another agent's trust list — the operator never enumerates that
  // capability on the wire.
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function requireExistingAgent(
  repo: OperatorRepository,
  rawHandle: unknown,
): AgentRecord {
  const handle = assertHandle(rawHandle, "path handle");
  const got = repo.agents.byHandle(handle);
  if (got === null) throw new NotFoundError(`agent ${handle} not found`);
  return got;
}

function parseOptionalPolicy(value: unknown): InboundPolicy | undefined {
  if (value === undefined || value === null) return undefined;
  if (value !== "allowlist" && value !== "open") {
    throw new BadRequestError(
      `policy must be "allowlist" or "open" (got ${JSON.stringify(value)})`,
      "INVALID_POLICY",
    );
  }
  return value;
}

interface ParsedProfileFields {
  readonly displayName?: string;
  readonly description?: string | null;
  readonly cardBody?: string | null;
  readonly visibility?: AgentVisibility;
}

/**
 * Parse the optional profile fields from a request body. Each field is
 * independently optional: omitting one leaves the stored value untouched
 * on PATCH and falls through to defaults on POST. `description` and
 * `card_body` accept `null` to clear; `display_name` must be a non-empty
 * string when supplied. `visibility` is checked against the storage enum.
 */
function parseProfileFields(body: Record<string, unknown>): ParsedProfileFields {
  const out: { -readonly [K in keyof ParsedProfileFields]: ParsedProfileFields[K] } = {};
  if (body.display_name !== undefined) {
    if (typeof body.display_name !== "string" || body.display_name.length === 0) {
      throw new BadRequestError(
        "display_name must be a non-empty string",
        "INVALID_DISPLAY_NAME",
      );
    }
    out.displayName = body.display_name;
  }
  if (body.description !== undefined) {
    if (body.description !== null && typeof body.description !== "string") {
      throw new BadRequestError(
        "description must be a string or null",
        "INVALID_DESCRIPTION",
      );
    }
    out.description = body.description;
  }
  if (body.card_body !== undefined) {
    if (body.card_body !== null && typeof body.card_body !== "string") {
      throw new BadRequestError(
        "card_body must be a string or null",
        "INVALID_CARD_BODY",
      );
    }
    out.cardBody = body.card_body;
  }
  if (body.visibility !== undefined) {
    if (body.visibility !== "public" && body.visibility !== "private") {
      throw new BadRequestError(
        `visibility must be "public" or "private" (got ${JSON.stringify(body.visibility)})`,
        "INVALID_VISIBILITY",
      );
    }
    out.visibility = body.visibility;
  }
  return out;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    typeof (err as { code?: unknown }).code === "string" &&
    (err as { code: string }).code.startsWith("SQLITE_CONSTRAINT")
  );
}

interface SerializeOpts {
  readonly includeToken?: string;
}

function serializeAgent(
  repo: OperatorRepository,
  agent: AgentRecord,
  opts: SerializeOpts = {},
): AgentResponse {
  const allowlist = repo.agents
    .listAllowlist(agent.handle)
    .map((e: AllowlistRow) => e.entry);
  return {
    handle: agent.handle,
    ...(opts.includeToken !== undefined ? { token: opts.includeToken } : {}),
    policy: agent.inboundPolicy,
    allowlist,
    display_name: agent.displayName,
    description: agent.description,
    card_body: agent.cardBody,
    visibility: agent.visibility,
  };
}

