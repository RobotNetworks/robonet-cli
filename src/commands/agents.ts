import { Command } from "commander";

import { resolveAgentToken } from "../asp/auth-resolver.js";
import { AspApiError } from "../asp/errors.js";
import { handleArg } from "../asp/handles.js";
import { AgentDirectoryClient } from "../agents/client.js";
import { CapabilityNotSupportedError } from "../agents/errors.js";
import {
  isFullAgentResponse,
  type AgentDetail,
  type AgentDetailResponse,
  type AgentResponse,
  type AgentSearchResult,
  type AgentSelfUpdate,
  type OrganizationSearchResult,
  type PersonSearchResult,
} from "../agents/types.js";
import type { CLIConfig } from "../config.js";
import { RobotNetCLIError } from "../errors.js";
import { loadConfigForAgentCommand, out } from "./asp-shared.js";

/**
 * `robotnet agents` — public/discovery view of agents on the network.
 *
 * Distinct from singular `robotnet agent` (admin-token-driven, only exposes
 * the operator's `/_admin/*` surface). This group authenticates as the
 * active agent and reaches the network's discovery surface:
 * `GET /agents/{owner}/{name}`, `/card`, `GET /search/agents`. Restored from
 * the pre-ASP-migration command set; on networks without a discovery
 * surface (the in-tree local operator) commands surface a
 * {@link CapabilityNotSupportedError}.
 */
export function registerAgentsCommand(program: Command): void {
  const agents = new Command("agents").description(
    "Discover agents on the network (search, profile, card)",
  );

  agents.addCommand(makeShowCmd());
  agents.addCommand(makeCardCmd());
  agents.addCommand(makeSearchCmd());

  program.addCommand(agents);
}

/**
 * Top-level `robotnet me` — show or update the active agent's own profile.
 * Sibling to `agents`; backed by the same hosted endpoints (`/agents/me`),
 * which already accept agent-bearer auth.
 */
export function registerMeCommand(program: Command): void {
  const me = new Command("me").description(
    "Show or update the calling agent's own profile",
  );
  me.addCommand(makeMeShowCmd());
  me.addCommand(makeMeUpdateCmd());
  program.addCommand(me);
}

/**
 * Top-level `robotnet search` — directory-wide search across agents, people,
 * and organisations on the active network. Sibling to the `agents` group.
 */
export function registerSearchCommand(program: Command): void {
  program.addCommand(makeDirectorySearchCmd());
}

// ── agents show ──────────────────────────────────────────────────────────────

function makeShowCmd(): Command {
  return new Command("show")
    .description("Show an agent's profile by handle")
    .argument("<handle>", "Agent handle (e.g. @nick.cli)", handleArg)
    .option("--as <handle>", "Act as this agent handle", handleArg)
    .option("--json", "Emit machine-readable JSON", false)
    .action(async (handle: string, opts: ShowOpts, cmd: Command) => {
      const { config, identity } = await loadConfigForAgentCommand(cmd, opts.as);
      const client = await buildClient(config, identity.handle);
      const detail = await runWithNotFoundHint(
        () => client.getAgent(handle),
        handle,
        identity.handle,
      );
      if (opts.json) {
        out(JSON.stringify(detail, null, 2));
        return;
      }
      renderAgentDetailResponse(detail);
    });
}

interface ShowOpts {
  readonly as?: string;
  readonly json: boolean;
}

// ── agents card ──────────────────────────────────────────────────────────────

function makeCardCmd(): Command {
  return new Command("card")
    .description("Print an agent's card body (markdown) by handle")
    .argument("<handle>", "Agent handle (e.g. @nick.cli)", handleArg)
    .option("--as <handle>", "Act as this agent handle", handleArg)
    .option("--json", "Emit machine-readable JSON", false)
    .action(async (handle: string, opts: CardOpts, cmd: Command) => {
      const { config, identity } = await loadConfigForAgentCommand(cmd, opts.as);
      const client = await buildClient(config, identity.handle);
      const card = await runWithNotFoundHint(
        () => client.getAgentCard(handle),
        handle,
        identity.handle,
      );
      if (opts.json) {
        out(JSON.stringify({ handle, card_body: card }, null, 2));
        return;
      }
      out(card);
    });
}

interface CardOpts {
  readonly as?: string;
  readonly json: boolean;
}

// ── search command builder (shared by `agents search` and top-level `search`) ─

interface SearchOpts {
  readonly query: string;
  readonly limit: number;
  readonly as?: string;
  readonly json: boolean;
}

function makeSearchCommand<T>(args: {
  readonly description: string;
  readonly limitDescription: string;
  readonly call: (
    client: AgentDirectoryClient,
    query: string,
    limit: number,
  ) => Promise<T>;
  readonly render: (result: T) => void;
}): Command {
  return new Command("search")
    .description(args.description)
    .requiredOption("--query <text>", "Search query (2-100 chars)")
    .option("--limit <n>", args.limitDescription, parseLimit, 20)
    .option("--as <handle>", "Act as this agent handle", handleArg)
    .option("--json", "Emit machine-readable JSON", false)
    .action(async (opts: SearchOpts, cmd: Command) => {
      const { config, identity } = await loadConfigForAgentCommand(cmd, opts.as);
      const client = await buildClient(config, identity.handle);
      const result = await args.call(client, opts.query, opts.limit);
      if (opts.json) {
        out(JSON.stringify(result, null, 2));
        return;
      }
      args.render(result);
    });
}

function makeSearchCmd(): Command {
  return makeSearchCommand({
    description: "Search for agents visible to the calling agent",
    limitDescription: "Maximum results (1..50)",
    call: (client, q, l) => client.searchAgents(q, l),
    render: (r) => renderAgentSearchResults(r.agents),
  });
}

function makeDirectorySearchCmd(): Command {
  return makeSearchCommand({
    description:
      "Search the network directory for agents, people, and organizations",
    limitDescription: "Maximum results per section (1..50)",
    call: (client, q, l) => client.searchDirectory(q, l),
    render: (r) => {
      renderAgentSearchResults(r.agents, "Agents");
      renderPeopleResults(r.people);
      renderOrganizationResults(r.organizations);
    },
  });
}

// ── me show / me update ──────────────────────────────────────────────────────

function makeMeShowCmd(): Command {
  return new Command("show")
    .description("Show the calling agent's own profile")
    .option("--as <handle>", "Act as this agent handle", handleArg)
    .option("--json", "Emit machine-readable JSON", false)
    .action(async (opts: MeShowOpts, cmd: Command) => {
      const { config, identity } = await loadConfigForAgentCommand(cmd, opts.as);
      const client = await buildClient(config, identity.handle);
      const self = await client.getSelf();
      if (opts.json) {
        out(JSON.stringify(self, null, 2));
        return;
      }
      renderAgentDetail(self);
    });
}

interface MeShowOpts {
  readonly as?: string;
  readonly json: boolean;
}

function makeMeUpdateCmd(): Command {
  return new Command("update")
    .description("Update the calling agent's card content (display name, description, card body)")
    .option("--display-name <name>", "Set display name")
    .option("--description <text>", "Set description (pass empty string to clear)")
    .option("--card-body <markdown>", "Set card body (pass empty string to clear)")
    .option("--as <handle>", "Act as this agent handle", handleArg)
    .option("--json", "Emit machine-readable JSON", false)
    .action(async (opts: MeUpdateOpts, cmd: Command) => {
      const update: { -readonly [K in keyof AgentSelfUpdate]: AgentSelfUpdate[K] } = {};
      if (opts.displayName !== undefined) {
        update.display_name = opts.displayName;
      }
      if (opts.description !== undefined) {
        update.description = opts.description.length > 0 ? opts.description : null;
      }
      if (opts.cardBody !== undefined) {
        update.card_body = opts.cardBody.length > 0 ? opts.cardBody : null;
      }
      if (Object.keys(update).length === 0) {
        throw new RobotNetCLIError(
          "Nothing to update. Provide at least one of --display-name, --description, or --card-body.",
        );
      }
      const { config, identity } = await loadConfigForAgentCommand(cmd, opts.as);
      const client = await buildClient(config, identity.handle);
      const updated = await client.updateSelf(update);
      if (opts.json) {
        out(JSON.stringify(updated, null, 2));
        return;
      }
      out("Updated.");
      renderAgentDetail(updated);
    });
}

interface MeUpdateOpts {
  readonly displayName?: string;
  readonly description?: string;
  readonly cardBody?: string;
  readonly as?: string;
  readonly json: boolean;
}

// ── shared helpers ───────────────────────────────────────────────────────────

async function buildClient(
  config: CLIConfig,
  handle: string,
): Promise<AgentDirectoryClient> {
  if (config.network.authMode !== "oauth") {
    throw new CapabilityNotSupportedError(config.network.name, "agent discovery");
  }
  const { token } = await resolveAgentToken(config, handle);
  return new AgentDirectoryClient(config.network.url, token, config.network.name);
}

function parseLimit(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n < 1 || n > 50) {
    throw new RobotNetCLIError(
      `--limit must be an integer between 1 and 50 (got ${JSON.stringify(value)})`,
    );
  }
  return n;
}

/**
 * Wrap a discovery call so the privacy-preserving 404 from the hosted backend
 * surfaces as a plainspoken "not found or not visible" hint instead of a raw
 * `ASP API error 404: http_404` line. Other errors propagate unchanged.
 */
async function runWithNotFoundHint<T>(
  call: () => Promise<T>,
  targetHandle: string,
  callerHandle: string,
): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof AspApiError && err.status === 404) {
      throw new RobotNetCLIError(
        `Agent ${targetHandle} not found, or not visible to ${callerHandle}.`,
      );
    }
    throw err;
  }
}

// ── renderers ────────────────────────────────────────────────────────────────

function renderAgentDetailResponse(detail: AgentDetailResponse): void {
  renderAgentDetail(detail.agent);
  // Only `owner` is meaningful to surface — `none` (authenticated, no
  // relationship) and `anonymous` (unauthenticated) both mean "no
  // relationship" and would render an awkward bare label.
  if (detail.viewer.relationship === "owner") {
    out(`  Relationship: owner${detail.viewer.can_edit ? " (can edit)" : ""}`);
  }
  if (detail.shared_sessions.length > 0) {
    out("");
    out(`Shared sessions (${detail.shared_sessions.length}):`);
    for (const s of detail.shared_sessions) {
      const topic = s.topic ?? "(no topic)";
      out(`  - ${s.id}  [${s.state}]  ${topic}`);
    }
  }
}

function renderAgentDetail(detail: AgentDetail): void {
  out(`Agent ${detail.canonical_handle}`);
  out(`  Display name: ${detail.display_name}`);
  out(`  Status:       ${detail.is_online ? "online" : "offline"}`);
  out(`  Visibility:   ${detail.visibility}`);
  out(`  Inbound:      ${detail.inbound_policy}`);
  if (detail.inactive) out(`  Inactive:     true`);
  out(`  Owner:        ${detail.owner_display_name} (${detail.owner_label})`);
  if (detail.description !== null && detail.description.length > 0) {
    out(`  Description:  ${detail.description}`);
  }

  if (!isFullAgentResponse(detail)) return;

  if (detail.paused) out(`  Paused:       true`);
  if (detail.skills !== null && detail.skills.length > 0) {
    out("");
    out("Skills:");
    for (const s of detail.skills) {
      out(`  - ${s.name}: ${s.description}`);
    }
  }
  if (detail.card_body !== null && detail.card_body.length > 0) {
    out("");
    out("Card:");
    // Preserve markdown line breaks; the terminal renders the markdown source
    // verbatim — matches the documented restoration behaviour from before
    // the ASP migration.
    for (const line of detail.card_body.split("\n")) {
      out(`  ${line}`);
    }
  }
}

function renderAgentSearchResults(
  results: readonly AgentSearchResult[],
  heading?: string,
): void {
  if (heading !== undefined) {
    out(`${heading} (${results.length})`);
  }
  if (results.length === 0) {
    out("  (no matches)");
    return;
  }
  for (const a of results) {
    out(`  ${a.canonical_handle}  ${a.display_name}`);
  }
}

function renderPeopleResults(results: readonly PersonSearchResult[]): void {
  out("");
  out(`People (${results.length})`);
  if (results.length === 0) {
    out("  (no matches)");
    return;
  }
  for (const p of results) {
    out(`  @${p.username}  ${p.display_name}`);
  }
}

function renderOrganizationResults(
  results: readonly OrganizationSearchResult[],
): void {
  out("");
  out(`Organizations (${results.length})`);
  if (results.length === 0) {
    out("  (no matches)");
    return;
  }
  for (const o of results) {
    out(`  ${o.slug}  ${o.name}`);
  }
}
