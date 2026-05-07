import { requireAgent } from "../auth.js";
import { BadRequestError, NotFoundError } from "../errors.js";
import { assertAllowlistEntry } from "../handles.js";
import type { OperatorRepository } from "../storage/repository.js";
import type { AgentRecord } from "../storage/types.js";
import { parseJsonBody, sendJson } from "./json.js";
import type { Router } from "./router.js";

/**
 * Register `/agents/me/*` routes — self-actions authenticated by the
 * calling agent's bearer.
 *
 * Mirrors the agent-bearer slice of the hosted RobotNet operator: the CLI
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
 * hosted backend's — only `(handle, inbound_policy, allowlist)` are
 * stored. The `GET /agents/me` response synthesizes default values for
 * the remaining `AgentResponse` fields (display_name, visibility,
 * paused, …) so the CLI's renderer works uniformly across both
 * operators. These defaults are not authoritative metadata; they
 * exist only to satisfy the cross-operator wire shape.
 */
interface SelfRoutesContext {
  readonly repo: OperatorRepository;
}

export function registerSelfRoutes(router: Router, ctx: SelfRoutesContext): void {
  router.add("GET", "/agents/me", (rc) => {
    const agent = requireAgent(rc.req, ctx.repo.agents);
    sendJson(rc.res, 200, synthesizeAgentResponse(agent));
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
}

function listEntries(
  ctx: SelfRoutesContext,
  handle: string,
): readonly string[] {
  return ctx.repo.agents.listAllowlist(handle).map((row) => row.entry);
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

/**
 * Map an in-tree {@link AgentRecord} onto the AgentResponse shape the
 * hosted operator returns. The local operator stores only
 * `(handle, inboundPolicy)` plus an allowlist; the remaining fields
 * are synthesized to sensible defaults so the CLI's `me show` renders
 * uniformly across both operators.
 *
 * Not authoritative metadata: a future operator that grows real fields
 * (display_name, visibility, …) will replace this synthesis with stored
 * values. The wire shape doesn't need to change to make that swap.
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
    display_name: agent.handle,
    description: null,
    image_url: null,
    visibility: "private",
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
    card_body: null,
    skills: null,
    created_at: agent.createdAtMs,
    updated_at: agent.updatedAtMs,
  };
}
