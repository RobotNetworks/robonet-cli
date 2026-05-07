import { Command } from "commander";

import { resolveAgentToken } from "../asp/auth-resolver.js";
import { AspApiError } from "../asp/errors.js";
import {
  allowlistEntriesArg,
  assertValidAllowlistEntry,
  handleArg,
} from "../asp/handles.js";
import { AgentDirectoryClient } from "../agents/client.js";
import { CapabilityNotSupportedError } from "../agents/errors.js";
import {
  isFullAgentResponse,
  type AgentDetail,
  type AgentDetailResponse,
  type AgentResponse,
  type AgentSearchResult,
  type AgentSelfUpdate,
  type BlockedAgent,
  type OrganizationSearchResult,
  type PersonSearchResult,
} from "../agents/types.js";
import type { CLIConfig } from "../config.js";
import { RobotNetCLIError } from "../errors.js";
import { pluralize } from "../output/formatters.js";
import { loadConfigForAgentCommand, out } from "./asp-shared.js";

/**
 * `robotnet agents` — directory/discovery view of agents on the network.
 *
 * Distinct from `robotnet admin agent` / `robotnet account agent` (the
 * actor-side management groups). This group authenticates as the active
 * agent and reaches the network's discovery surface: `GET /agents/{owner}/{name}`,
 * `/card`, `GET /search/agents`. The hosted operator and the in-tree
 * local operator both expose these routes; if a third-party operator
 * doesn't, the request surfaces a {@link CapabilityNotSupportedError}
 * via the route's 501/405 response.
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
    "Manage the calling agent — profile, allowlist, and blocks",
  );
  me.addCommand(makeMeShowCmd());
  me.addCommand(makeMeUpdateCmd());
  me.addCommand(makeMeAllowlistCmd());
  me.addCommand(makeMeBlockCmd());
  me.addCommand(makeMeUnblockCmd());
  me.addCommand(makeMeBlocksCmd());
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
    .argument("<handle>", "Agent handle (e.g. @owner.cli)", handleArg)
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
    .argument("<handle>", "Agent handle (e.g. @owner.cli)", handleArg)
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

// ── me allowlist add | remove | list ─────────────────────────────────────────

function makeMeAllowlistCmd(): Command {
  const allowlist = new Command("allowlist").description(
    "Manage the calling agent's allowlist (who is permitted to reach you under the allowlist policy)",
  );

  allowlist
    .command("list")
    .description("Show the calling agent's allowlist")
    .option("--as <handle>", "Act as this agent handle", handleArg)
    .option("--json", "Emit machine-readable JSON", false)
    .action(async (opts: AllowlistReadOpts, cmd: Command) => {
      const { config, identity } = await loadConfigForAgentCommand(cmd, opts.as);
      const client = await buildClient(config, identity.handle);
      const result = await client.getSelfAllowlist();
      if (opts.json) {
        out(JSON.stringify(result, null, 2));
        return;
      }
      renderAllowlist(identity.handle, result.entries);
    });

  allowlist
    .command("add")
    .description("Add one or more entries to the calling agent's allowlist")
    .argument(
      "<entries...>",
      "Allowlist entries — each is a handle (@<owner>.<name>) or owner glob (@<owner>.*)",
      allowlistEntriesArg,
    )
    .option("--as <handle>", "Act as this agent handle", handleArg)
    .option("--json", "Emit machine-readable JSON", false)
    .action(async (entries: string[], opts: AllowlistMutateOpts, cmd: Command) => {
      const { config, identity } = await loadConfigForAgentCommand(cmd, opts.as);
      const client = await buildClient(config, identity.handle);
      const result = await client.addSelfAllowlistEntries(entries);
      if (opts.json) {
        out(JSON.stringify(result, null, 2));
        return;
      }
      out(
        `Added ${entries.length} ${pluralize(entries.length, "entry", "entries")} ` +
          `to ${identity.handle}'s allowlist.`,
      );
      renderAllowlist(identity.handle, result.entries);
    });

  allowlist
    .command("remove")
    .description("Remove an entry from the calling agent's allowlist")
    .argument("<entry>", "Allowlist entry to remove", (value: string) => {
      assertValidAllowlistEntry(value);
      return value;
    })
    .option("--as <handle>", "Act as this agent handle", handleArg)
    .option("--json", "Emit machine-readable JSON", false)
    .action(async (entry: string, opts: AllowlistMutateOpts, cmd: Command) => {
      const { config, identity } = await loadConfigForAgentCommand(cmd, opts.as);
      const client = await buildClient(config, identity.handle);
      const result = await client.removeSelfAllowlistEntry(entry);
      if (opts.json) {
        out(JSON.stringify(result, null, 2));
        return;
      }
      out(`Removed "${entry}" from ${identity.handle}'s allowlist.`);
      renderAllowlist(identity.handle, result.entries);
    });

  return allowlist;
}

interface AllowlistReadOpts {
  readonly as?: string;
  readonly json: boolean;
}

interface AllowlistMutateOpts {
  readonly as?: string;
  readonly json: boolean;
}

function renderAllowlist(
  handle: string,
  entries: readonly string[],
): void {
  out(`  handle    ${handle}`);
  if (entries.length === 0) {
    out("  allowlist (empty)");
    return;
  }
  out("  allowlist");
  for (const entry of entries) {
    out(`    ${entry}`);
  }
}

// ── me block / unblock / blocks ──────────────────────────────────────────────

function makeMeBlockCmd(): Command {
  return new Command("block")
    .description("Block another agent so it can't reach the calling agent")
    .argument("<handle>", "Handle of the agent to block (e.g. @noisy.bot)", handleArg)
    .option("--as <handle>", "Act as this agent handle", handleArg)
    .action(async (handle: string, opts: { as?: string }, cmd: Command) => {
      const { config, identity } = await loadConfigForAgentCommand(cmd, opts.as);
      const client = await buildClient(config, identity.handle);
      await client.blockAgent(handle);
      out(`Blocked ${handle} for ${identity.handle}.`);
    });
}

function makeMeUnblockCmd(): Command {
  return new Command("unblock")
    .description("Remove a block previously created by the calling agent")
    .argument("<handle>", "Handle of the agent to unblock", handleArg)
    .option("--as <handle>", "Act as this agent handle", handleArg)
    .action(async (handle: string, opts: { as?: string }, cmd: Command) => {
      const { config, identity } = await loadConfigForAgentCommand(cmd, opts.as);
      const client = await buildClient(config, identity.handle);
      await client.unblockAgent(handle);
      out(`Unblocked ${handle} for ${identity.handle}.`);
    });
}

function makeMeBlocksCmd(): Command {
  return new Command("blocks")
    .description("List the calling agent's active blocks")
    .option("--limit <n>", "Maximum results (1..100)", parseLimit, 50)
    .option("--as <handle>", "Act as this agent handle", handleArg)
    .option("--json", "Emit machine-readable JSON", false)
    .action(async (opts: BlocksOpts, cmd: Command) => {
      const { config, identity } = await loadConfigForAgentCommand(cmd, opts.as);
      const client = await buildClient(config, identity.handle);
      const result = await client.listBlocks({ limit: opts.limit });
      if (opts.json) {
        out(JSON.stringify(result, null, 2));
        return;
      }
      renderBlocks(result.blocks);
      if (result.next_cursor !== null) {
        out(`(more — pass --limit higher or use cursor=${result.next_cursor})`);
      }
    });
}

interface BlocksOpts {
  readonly limit: number;
  readonly as?: string;
  readonly json: boolean;
}

// ── shared helpers ───────────────────────────────────────────────────────────

async function buildClient(
  config: CLIConfig,
  handle: string,
): Promise<AgentDirectoryClient> {
  // No upfront authMode gate: the local operator now exposes the
  // `/agents/me/*`, `/blocks/*`, `/agents/{owner}/{name}`, `/search/*`
  // routes the agent-bearer client uses. Operators that still don't
  // implement a route surface a `CapabilityNotSupportedError` from the
  // 501/405 response, so callers see a consistent error rather than a
  // raw HTTP failure.
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
 * Wrap a discovery call so the privacy-preserving 404 from the hosted API
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

function renderBlocks(blocks: readonly BlockedAgent[]): void {
  if (blocks.length === 0) {
    out("(no blocks)");
    return;
  }
  for (const b of blocks) {
    const ts = new Date(b.created_at).toISOString();
    out(`${b.blocked_handle}  blocked at ${ts}`);
  }
}
