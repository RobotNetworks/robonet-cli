import type Database from "better-sqlite3";

import { requireAdmin } from "../auth.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../errors.js";
import { assertAllowlistEntry, assertHandle } from "../handles.js";
import type { OperatorRepository } from "../storage/repository.js";
import type {
  AgentRecord,
  AllowlistEntry as AllowlistRow,
  Handle,
  InboundPolicy,
} from "../storage/types.js";
import { mintBearerToken, sha256Hex } from "../tokens.js";
import { parseJsonBody, sendJson, sendNoContent } from "./json.js";
import type { Router, RouteContext } from "./router.js";

/** Wire shape for an agent — mirrors the asp reference operator. The bearer
 * token is included only on register / rotate-token responses (we hash on
 * write so it's not recoverable on subsequent reads). */
interface AgentResponse {
  readonly handle: Handle;
  readonly token?: string;
  readonly policy: InboundPolicy;
  readonly allowlist: readonly string[];
}

interface AdminContext {
  readonly repo: OperatorRepository;
  readonly db: Database.Database;
  readonly adminTokenHash: string;
}

/**
 * Register `/_admin/*` routes on `router`.
 *
 * All admin routes require the admin bearer (verified via
 * {@link requireAdmin}). Errors are typed {@link OperatorError} subclasses
 * that the route layer's error boundary maps to ASP-shaped envelopes.
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
    let updated = agent;
    if (policy !== undefined) {
      ctx.repo.agents.setInboundPolicy(agent.handle, policy);
      updated = ctx.repo.agents.byHandle(agent.handle) ?? agent;
    }
    sendJson(rc.res, 200, serializeAgent(ctx.repo, updated));
  }));

  router.add("POST", "/_admin/agents/:handle/allowlist", guard(async (rc) => {
    const agent = requireExistingAgent(ctx.repo, rc.params.handle);
    const body = await parseJsonBody(rc.req);
    const entries = parseEntriesArray(body.entries);
    // Wrap the multi-insert in a transaction so a partial failure rolls
    // back cleanly. Each insert is itself idempotent (ON CONFLICT DO NOTHING).
    ctx.db.transaction(() => {
      for (const entry of entries) {
        ctx.repo.agents.addAllowlistEntry(agent.handle, entry);
      }
    })();
    const fresh = ctx.repo.agents.byHandle(agent.handle) ?? agent;
    sendJson(rc.res, 200, serializeAgent(ctx.repo, fresh));
  }));

  router.add(
    "DELETE",
    "/_admin/agents/:handle/allowlist/:entry",
    guard((rc) => {
      const agent = requireExistingAgent(ctx.repo, rc.params.handle);
      const entry = assertAllowlistEntry(rc.params.entry, "path entry");
      if (!ctx.repo.agents.removeAllowlistEntry(agent.handle, entry)) {
        throw new NotFoundError(
          `allowlist entry ${entry} not found on ${agent.handle}`,
        );
      }
      const fresh = ctx.repo.agents.byHandle(agent.handle) ?? agent;
      sendJson(rc.res, 200, serializeAgent(ctx.repo, fresh));
    }),
  );
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

function parseEntriesArray(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new BadRequestError(
      "entries must be a non-empty array",
      "INVALID_ENTRIES",
    );
  }
  return value.map((e, i) => assertAllowlistEntry(e, `entries[${i}]`));
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
  };
}

