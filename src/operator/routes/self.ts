import { requireAgent } from "../auth.js";
import type { SessionService } from "../domain/sessions.js";
import { BadRequestError, NotFoundError } from "../errors.js";
import { assertAllowlistEntry, assertHandle } from "../handles.js";
import type {
  OperatorRepository,
  UpdateAgentProfileInput,
} from "../storage/repository.js";
import type { AgentRecord, BlockRecord, Handle } from "../storage/types.js";
import { parseJsonBody, sendJson, sendText } from "./json.js";
import type { Router } from "./router.js";

/**
 * Register `/agents/me/*` routes — self-actions authenticated by the
 * calling agent's bearer.
 *
 * Mirrors the agent-bearer slice of the hosted Robot Networks operator: the CLI
 * (`robotnet me ...`) talks to whichever operator the resolved network
 * points at, with one wire shape across both. Today this covers self
 * profile (`GET /agents/me`) and the self-allowlist surface; blocks land
 * later when the local operator grows the corresponding storage.
 *
 * No third-party path exists. Allowlist mutation is always self-edit:
 * `requireAgent` resolves the calling agent from the bearer; every write
 * targets that agent's own row and never accepts an out-of-band handle.
 *
 * The local operator's data model is intentionally thinner than the
 * full ASP agent profile — only `(handle, inbound_policy, allowlist)` are
 * stored. The `GET /agents/me` response synthesizes default values for
 * the remaining `AgentResponse` fields (display_name, visibility,
 * paused, …) so the CLI's renderer works uniformly across operators.
 * These defaults are not authoritative metadata; they exist only to
 * satisfy the cross-operator wire shape.
 */
interface SelfRoutesContext {
  readonly repo: OperatorRepository;
  readonly sessions: SessionService;
}

export function registerSelfRoutes(router: Router, ctx: SelfRoutesContext): void {
  router.add("GET", "/agents/me", (rc) => {
    const agent = requireAgent(rc.req, ctx.repo.agents);
    sendJson(rc.res, 200, synthesizeAgentResponse(agent));
  });

  router.add("PATCH", "/agents/me", async (rc) => {
    const agent = requireAgent(rc.req, ctx.repo.agents);
    const body = await parseJsonBody(rc.req);
    const update = parseSelfUpdate(body);
    if (Object.keys(update).length === 0) {
      throw new BadRequestError(
        "no updatable fields supplied (display_name, description, card_body)",
        "INVALID_UPDATE",
      );
    }
    const updated = ctx.repo.agents.updateProfile(agent.handle, update);
    if (updated === null) {
      // Defensive: byBearerHash matched seconds ago, so the row exists.
      // A concurrent admin DELETE between requireAgent and updateProfile
      // is the only realistic way to land here.
      throw new NotFoundError(`agent ${agent.handle} not found`);
    }
    sendJson(rc.res, 200, synthesizeAgentResponse(updated));
  });

  router.add("GET", "/agents/me/allowlist", (rc) => {
    const agent = requireAgent(rc.req, ctx.repo.agents);
    sendJson(rc.res, 200, { entries: listEntries(ctx, agent.handle) });
  });

  router.add("POST", "/agents/me/allowlist", async (rc) => {
    const agent = requireAgent(rc.req, ctx.repo.agents);
    const body = await parseJsonBody(rc.req);
    const entries = parseEntriesArray(body.entries);
    // Each insert is itself idempotent (ON CONFLICT DO NOTHING). No
    // transaction needed — partial application of a batch is acceptable
    // because re-issuing the same request safely no-ops the duplicates
    // and applies any missing entries.
    for (const entry of entries) {
      ctx.repo.agents.addAllowlistEntry(agent.handle, entry);
    }
    sendJson(rc.res, 200, { entries: listEntries(ctx, agent.handle) });
  });

  router.add("DELETE", "/agents/me/allowlist/:entry", (rc) => {
    const agent = requireAgent(rc.req, ctx.repo.agents);
    const entry = assertAllowlistEntry(rc.params.entry, "path entry");
    if (!ctx.repo.agents.removeAllowlistEntry(agent.handle, entry)) {
      throw new NotFoundError(
        `allowlist entry ${entry} not found on ${agent.handle}`,
      );
    }
    sendJson(rc.res, 200, { entries: listEntries(ctx, agent.handle) });
  });

  // ── /blocks (calling agent's block list) ────────────────────────────────

  router.add("GET", "/agents/me/blocks", (rc) => {
    const agent = requireAgent(rc.req, ctx.repo.agents);
    const limit = parseLimitParam(rc.url.searchParams.get("limit"));
    const offset = parseOffsetCursor(rc.url.searchParams.get("cursor"));
    const rows = ctx.repo.blocks.list(agent.handle, {
      ...(limit !== undefined ? { limit } : {}),
      ...(offset !== undefined ? { offset } : {}),
    });
    sendJson(rc.res, 200, {
      blocks: rows.map(serializeBlock),
      next_cursor:
        rows.length === (limit ?? 100)
          ? encodeOffsetCursor((offset ?? 0) + rows.length)
          : null,
    });
  });

  router.add("POST", "/agents/me/blocks", async (rc) => {
    const agent = requireAgent(rc.req, ctx.repo.agents);
    const body = await parseJsonBody(rc.req);
    const blockedHandle = assertHandle(body.handle, "handle");
    if (blockedHandle === agent.handle) {
      throw new BadRequestError(
        "cannot block yourself",
        "INVALID_BLOCK_TARGET",
      );
    }
    const row = ctx.repo.blocks.add(agent.handle, blockedHandle);
    // ASP §6.2 — a new block MUST force-leave the blocked agent from
    // any session both agents are currently participating in. Routing
    // stops immediately; the blocked agent gets a `session.left` event
    // shape-identical to a voluntary leave (the spec is explicit that
    // the blocked agent is not informed it was blocked).
    ctx.sessions.forceLeaveSharedSessions(agent.handle, blockedHandle);
    sendJson(rc.res, 201, serializeBlock(row));
  });

  router.add("DELETE", "/agents/me/blocks/:ref", (rc) => {
    const agent = requireAgent(rc.req, ctx.repo.agents);
    const blockedHandle = assertHandle(rc.params.ref, "path handle");
    if (!ctx.repo.blocks.remove(agent.handle, blockedHandle)) {
      throw new NotFoundError(
        `not blocking ${blockedHandle}`,
      );
    }
    sendJson(rc.res, 200, { unblocked: true });
  });

  // ── /agents/{owner}/{agent_name}: discovery ─────────────────────────────

  router.add("GET", "/agents/:owner/:name", (rc) => {
    const caller = requireAgent(rc.req, ctx.repo.agents);
    const target = resolveDiscoveryTarget(ctx, rc.params.owner, rc.params.name, caller);
    sendJson(rc.res, 200, buildAgentDetailResponse(target, caller));
  });

  router.add("GET", "/agents/:owner/:name/card", (rc) => {
    const caller = requireAgent(rc.req, ctx.repo.agents);
    const target = resolveDiscoveryTarget(ctx, rc.params.owner, rc.params.name, caller);
    const body = target.cardBody ?? "";
    sendText(rc.res, 200, "text/markdown; charset=utf-8", body);
  });
}

function listEntries(
  ctx: SelfRoutesContext,
  handle: string,
): readonly string[] {
  return ctx.repo.agents.listAllowlist(handle).map((row) => row.entry);
}

/**
 * Resolve a `(owner, name)` URL pair to an agent visible to `caller`.
 *
 * Returns `404 NOT_FOUND` when:
 *   - no agent exists with that handle, or
 *   - the agent is private and the caller is neither the agent itself
 *     nor on the agent's allowlist.
 *
 * The 404 is privacy-preserving — a non-contact and a missing handle look
 * identical from the wire, so an enumerator can't probe the network.
 */
function resolveDiscoveryTarget(
  ctx: SelfRoutesContext,
  ownerParam: unknown,
  nameParam: unknown,
  caller: AgentRecord,
): AgentRecord {
  const handle = `@${assertSegment(ownerParam, "owner")}.${assertSegment(nameParam, "name")}`;
  const target = ctx.repo.agents.byHandle(handle);
  if (target === null) {
    throw new NotFoundError(`agent ${handle} not found`);
  }
  if (canViewAgent(ctx, target, caller)) return target;
  // Privacy-preserving: do not differentiate between "doesn't exist" and
  // "exists but not visible to you".
  throw new NotFoundError(`agent ${handle} not found`);
}

function canViewAgent(
  ctx: SelfRoutesContext,
  target: AgentRecord,
  caller: AgentRecord,
): boolean {
  if (target.visibility === "public") return true;
  if (target.handle === caller.handle) return true;
  const allowed = ctx.repo.agents
    .listAllowlist(target.handle)
    .some((row) => row.entry === caller.handle || row.entry === ownerGlob(caller.handle));
  return allowed;
}

function ownerGlob(handle: Handle): string {
  const stripped = handle.startsWith("@") ? handle.slice(1) : handle;
  const dot = stripped.indexOf(".");
  return dot >= 0 ? `@${stripped.slice(0, dot)}.*` : handle;
}

function assertSegment(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new BadRequestError(`${label} segment missing`, "INVALID_HANDLE");
  }
  return value;
}

function buildAgentDetailResponse(
  target: AgentRecord,
  caller: AgentRecord,
): Record<string, unknown> {
  const isOwner = target.handle === caller.handle;
  return {
    agent: synthesizeAgentResponse(target),
    shared_sessions: [],
    viewer: {
      relationship: isOwner ? "owner" : "none",
      can_edit: isOwner,
    },
  };
}

function parseSelfUpdate(body: Record<string, unknown>): UpdateAgentProfileInput {
  const out: { -readonly [K in keyof UpdateAgentProfileInput]: UpdateAgentProfileInput[K] } = {};
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
  return out;
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

function parseLimitParam(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    throw new BadRequestError(
      `limit must be an integer between 1 and 100 (got ${JSON.stringify(raw)})`,
      "INVALID_LIMIT",
    );
  }
  return n;
}

/**
 * Parse a base64-encoded offset cursor, or `null` for the first page.
 *
 * Cursors are opaque to clients but stable across paginated requests:
 * the operator emits one in `next_cursor` whenever the page hits the
 * limit, and clients echo it back on the next request via `?cursor=…`.
 */
function parseOffsetCursor(raw: string | null): number | undefined {
  if (raw === null || raw.length === 0) return undefined;
  try {
    const decoded = Buffer.from(raw, "base64").toString("utf-8");
    const parsed = JSON.parse(decoded) as { offset?: unknown };
    if (typeof parsed.offset === "number" && Number.isInteger(parsed.offset) && parsed.offset >= 0) {
      return parsed.offset;
    }
  } catch {
    // fall through to the BadRequest below
  }
  throw new BadRequestError("invalid cursor", "INVALID_CURSOR");
}

function encodeOffsetCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf-8").toString("base64");
}

function serializeBlock(row: BlockRecord): Record<string, unknown> {
  return {
    blocked_agent_id: row.blockedHandle,
    blocked_handle: row.blockedHandle,
    created_at: row.createdAtMs,
  };
}

/**
 * Map an in-tree {@link AgentRecord} onto the AgentResponse wire shape.
 * The local operator stores the profile fields the CLI's `me show`
 * renders directly (display_name, description, card_body, visibility);
 * fields with no local analogue (image_url, paused, skills,
 * owner-side personalia) are defaulted so the wire shape stays uniform
 * across operators.
 */
function synthesizeAgentResponse(agent: AgentRecord): Record<string, unknown> {
  const stripped = agent.handle.startsWith("@")
    ? agent.handle.slice(1)
    : agent.handle;
  const dot = stripped.indexOf(".");
  const owner = dot >= 0 ? stripped.slice(0, dot) : stripped;
  const localName = dot >= 0 ? stripped.slice(dot + 1) : stripped;
  return {
    canonical_handle: agent.handle,
    display_name: agent.displayName,
    description: agent.description,
    image_url: null,
    visibility: agent.visibility,
    inbound_policy: agent.inboundPolicy,
    inactive: false,
    is_online: true,
    owner_label: `@${owner}`,
    owner_display_name: owner,
    owner_image_url: null,
    id: agent.handle,
    local_name: localName,
    namespace: owner,
    owner_type: "account",
    owner_id: owner,
    scope: "personal",
    can_initiate_sessions: true,
    paused: false,
    card_body: agent.cardBody,
    skills: null,
    created_at: agent.createdAtMs,
    updated_at: agent.updatedAtMs,
  };
}
