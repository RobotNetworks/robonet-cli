import { Command } from "commander";

import { AccountClient } from "../account/client.js";
import type {
  AccountResponse,
  AccountSessionListItem,
  AgentCreate,
  AgentUpdate,
} from "../account/types.js";
import { CapabilityNotSupportedError } from "../agents/errors.js";
import type { AgentResponse } from "../agents/types.js";
import { resolveUserToken } from "../asp/auth-resolver.js";
import { handleArg } from "../asp/handles.js";
import type { CLIConfig } from "../config.js";
import { RobotNetCLIError } from "../errors.js";
import { loadConfigFromRoot, out } from "./asp-shared.js";

/**
 * `robotnet account` — operations against the calling **account** (the
 * human user that owns one or more agents). Authenticates with the user
 * session bearer from `robotnet login`; agent-bearer tokens are not
 * accepted by these routes (the backend refuses them at the auth
 * boundary).
 *
 * Distinct from:
 *  - `robotnet me` — acts as the calling agent (`/agents/me`).
 *  - `robotnet agents` — discovery against any agent on the network.
 *  - `robotnet agent` — admin-token operator surface (`/_admin/agents/*`).
 */
export function registerAccountCommand(program: Command): void {
  const account = new Command("account").description(
    "Operations against the calling account (the user that owns one or more agents)",
  );

  account.addCommand(makeShowCmd());

  const agents = new Command("agents").description(
    "Manage agents owned by the calling account",
  );
  agents.addCommand(makeAgentsListCmd());
  agents.addCommand(makeAgentsNewCmd());
  agents.addCommand(makeAgentsSetCmd());
  agents.addCommand(makeAgentsRmCmd());
  account.addCommand(agents);

  account.addCommand(makeSessionsCmd());

  program.addCommand(account);
}

// ── account show ─────────────────────────────────────────────────────────────

function makeShowCmd(): Command {
  return new Command("show")
    .description("Show the calling account (id, username, email, display name, tier)")
    .option("--json", "Emit machine-readable JSON", false)
    .action(async (opts: { json: boolean }, cmd: Command) => {
      const config = await loadConfigFromRoot(cmd);
      const client = await buildClient(config);
      const acc = await client.getAccount();
      if (opts.json) {
        out(JSON.stringify(acc, null, 2));
        return;
      }
      renderAccountSummary(acc);
    });
}

// ── account agents list ──────────────────────────────────────────────────────

function makeAgentsListCmd(): Command {
  return new Command("list")
    .description("List agents owned by the calling account")
    .option("--managed", "Include org-managed agents the account can act as", false)
    .option("--query <text>", "Filter by display name or handle (personal only)")
    .option("--limit <n>", "Maximum results (1..100)", parseLimit, 50)
    .option("--json", "Emit machine-readable JSON", false)
    .action(async (opts: ListOpts, cmd: Command) => {
      const config = await loadConfigFromRoot(cmd);
      const client = await buildClient(config);
      const result = opts.managed
        ? await client.listManagedAgents()
        : await client.listAgents({
            ...(opts.query !== undefined ? { query: opts.query } : {}),
            limit: opts.limit,
          });
      if (opts.json) {
        out(JSON.stringify(result, null, 2));
        return;
      }
      renderAgentList(result.agents);
      if (result.next_cursor !== null) {
        out(`(more — pass --limit higher or use cursor=${result.next_cursor})`);
      }
    });
}

interface ListOpts {
  readonly managed: boolean;
  readonly query?: string;
  readonly limit: number;
  readonly json: boolean;
}

// ── account agents new ───────────────────────────────────────────────────────

function makeAgentsNewCmd(): Command {
  return new Command("new")
    .description("Create a personal agent under the calling account")
    .argument("<local-name>", "Local agent name (2-32 chars, lowercase a-z0-9_-)")
    .requiredOption("--display-name <text>", "Human-readable display name (1-100 chars)")
    .option("--description <text>", "Short description (max 500 chars)")
    .option(
      "--visibility <visibility>",
      "Visibility: 'private' (default) or 'public'",
      parseVisibility,
    )
    .option(
      "--inbound-policy <policy>",
      "Inbound policy: 'allowlist' (default) or 'open' (paid tier only)",
      parseInboundPolicy,
    )
    .option(
      "--no-can-initiate",
      "Disallow this agent from creating outbound sessions (default: allowed)",
    )
    .option("--json", "Emit machine-readable JSON", false)
    .action(async (localName: string, opts: NewOpts, cmd: Command) => {
      const config = await loadConfigFromRoot(cmd);
      const client = await buildClient(config);
      const body: AgentCreate = {
        local_name: localName,
        display_name: opts.displayName,
        ...(opts.description !== undefined ? { description: opts.description } : {}),
        ...(opts.visibility !== undefined ? { visibility: opts.visibility } : {}),
        ...(opts.inboundPolicy !== undefined ? { inbound_policy: opts.inboundPolicy } : {}),
        ...(opts.canInitiate === false ? { can_initiate_sessions: false } : {}),
      };
      const created = await client.createAgent(body);
      if (opts.json) {
        out(JSON.stringify(created, null, 2));
        return;
      }
      out(`Created agent ${created.canonical_handle}`);
      renderAgentSummary(created);
    });
}

interface NewOpts {
  readonly displayName: string;
  readonly description?: string;
  readonly visibility?: "public" | "private";
  readonly inboundPolicy?: "allowlist" | "open";
  /** commander's `--no-can-initiate` produces a `canInitiate: false` here. */
  readonly canInitiate: boolean;
  readonly json: boolean;
}

// ── account agents set ───────────────────────────────────────────────────────

function makeAgentsSetCmd(): Command {
  return new Command("set")
    .description("Update agent settings (admin: visibility, policy, paused, capability flags)")
    .argument("<handle>", "Agent handle (e.g. @nick.cli)", handleArg)
    .option("--display-name <text>", "New display name")
    .option("--description <text>", "New description (empty string clears)")
    .option("--card-body <markdown>", "New card body (empty string clears)")
    .option("--visibility <visibility>", "Set visibility", parseVisibility)
    .option("--inbound-policy <policy>", "Set inbound policy", parseInboundPolicy)
    .option("--paused", "Pause the agent (refuses inbound sessions)")
    .option("--unpaused", "Unpause the agent")
    .option("--json", "Emit machine-readable JSON", false)
    .action(async (handle: string, opts: SetOpts, cmd: Command) => {
      const update: { -readonly [K in keyof AgentUpdate]: AgentUpdate[K] } = {};
      if (opts.displayName !== undefined) update.display_name = opts.displayName;
      if (opts.description !== undefined) {
        update.description = opts.description.length > 0 ? opts.description : null;
      }
      if (opts.cardBody !== undefined) {
        update.card_body = opts.cardBody.length > 0 ? opts.cardBody : null;
      }
      if (opts.visibility !== undefined) update.visibility = opts.visibility;
      if (opts.inboundPolicy !== undefined) update.inbound_policy = opts.inboundPolicy;
      if (opts.paused === true) update.paused = true;
      if (opts.unpaused === true) update.paused = false;
      if (Object.keys(update).length === 0) {
        throw new RobotNetCLIError(
          "Nothing to update. Provide at least one of --display-name, --description, --card-body, --visibility, --inbound-policy, --paused, --unpaused.",
        );
      }
      if (opts.paused === true && opts.unpaused === true) {
        throw new RobotNetCLIError(
          "Pass at most one of --paused / --unpaused.",
        );
      }
      const config = await loadConfigFromRoot(cmd);
      const client = await buildClient(config);
      const updated = await client.updateAgent(handle, update);
      if (opts.json) {
        out(JSON.stringify(updated, null, 2));
        return;
      }
      out(`Updated ${updated.canonical_handle}`);
      renderAgentSummary(updated);
    });
}

interface SetOpts {
  readonly displayName?: string;
  readonly description?: string;
  readonly cardBody?: string;
  readonly visibility?: "public" | "private";
  readonly inboundPolicy?: "allowlist" | "open";
  readonly paused?: boolean;
  readonly unpaused?: boolean;
  readonly json: boolean;
}

// ── account agents rm ────────────────────────────────────────────────────────

function makeAgentsRmCmd(): Command {
  return new Command("rm")
    .description("Delete an agent owned by the calling account")
    .argument("<handle>", "Agent handle (e.g. @nick.cli)", handleArg)
    .action(async (handle: string, _opts: unknown, cmd: Command) => {
      const config = await loadConfigFromRoot(cmd);
      const client = await buildClient(config);
      await client.deleteAgent(handle);
      out(`Deleted ${handle}`);
    });
}

// ── account sessions ─────────────────────────────────────────────────────────

function makeSessionsCmd(): Command {
  return new Command("sessions")
    .description(
      "List sessions across every agent the calling account owns or can act as",
    )
    .option("--state <state>", "Filter by state: 'active' or 'ended'", parseSessionState)
    .option("--limit <n>", "Maximum results per page (1..100)", parseLimit, 50)
    .option("--json", "Emit machine-readable JSON", false)
    .action(async (opts: SessionsOpts, cmd: Command) => {
      const config = await loadConfigFromRoot(cmd);
      const client = await buildClient(config);
      const result = await client.listSessions({
        ...(opts.state !== undefined ? { state: opts.state } : {}),
        limit: opts.limit,
      });
      if (opts.json) {
        out(JSON.stringify(result, null, 2));
        return;
      }
      renderAccountSessions(result.sessions);
      if (result.next_cursor !== null) {
        out(`(more — pass --limit higher or use cursor=${result.next_cursor})`);
      }
    });
}

interface SessionsOpts {
  readonly state?: "active" | "ended";
  readonly limit: number;
  readonly json: boolean;
}

// ── shared helpers ───────────────────────────────────────────────────────────

async function buildClient(config: CLIConfig): Promise<AccountClient> {
  if (config.network.authMode !== "oauth") {
    throw new CapabilityNotSupportedError(config.network.name, "account operations");
  }
  const { token } = await resolveUserToken(config);
  return new AccountClient(config.network.url, token, config.network.name);
}

function parseLimit(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    throw new RobotNetCLIError(
      `--limit must be an integer between 1 and 100 (got ${JSON.stringify(value)})`,
    );
  }
  return n;
}

function parseVisibility(value: string): "public" | "private" {
  if (value !== "public" && value !== "private") {
    throw new RobotNetCLIError(
      `--visibility must be 'public' or 'private' (got ${JSON.stringify(value)})`,
    );
  }
  return value;
}

function parseInboundPolicy(value: string): "allowlist" | "open" {
  if (value !== "allowlist" && value !== "open") {
    throw new RobotNetCLIError(
      `--inbound-policy must be 'allowlist' or 'open' (got ${JSON.stringify(value)})`,
    );
  }
  return value;
}

function parseSessionState(value: string): "active" | "ended" {
  if (value !== "active" && value !== "ended") {
    throw new RobotNetCLIError(
      `--state must be 'active' or 'ended' (got ${JSON.stringify(value)})`,
    );
  }
  return value;
}

// ── renderers ────────────────────────────────────────────────────────────────

function renderAccountSummary(acc: AccountResponse): void {
  const handle = acc.username !== null ? `@${acc.username}` : "(no username set)";
  out(`Account ${handle}`);
  out(`  Display name: ${acc.display_name}`);
  out(`  Email:        ${acc.email}`);
  out(`  Tier:         ${acc.tier}`);
  if (acc.bio !== null && acc.bio.length > 0) {
    out(`  Bio:          ${acc.bio}`);
  }
  out(`  Account id:   ${acc.id}`);
}

function renderAgentList(agents: readonly AgentResponse[]): void {
  if (agents.length === 0) {
    out("(no agents)");
    return;
  }
  for (const a of agents) {
    const status = a.is_online ? "online" : "offline";
    const flags: string[] = [a.visibility, a.inbound_policy];
    if (a.paused) flags.push("paused");
    if (a.inactive) flags.push("inactive");
    out(
      `${a.canonical_handle}  ${a.display_name}  [${flags.join(", ")}]  ${status}`,
    );
  }
}

function renderAgentSummary(a: AgentResponse): void {
  out(`  Display name: ${a.display_name}`);
  out(`  Visibility:   ${a.visibility}`);
  out(`  Inbound:      ${a.inbound_policy}`);
  if (a.paused) out(`  Paused:       true`);
  if (a.description !== null && a.description.length > 0) {
    out(`  Description:  ${a.description}`);
  }
}

function renderAccountSessions(items: readonly AccountSessionListItem[]): void {
  if (items.length === 0) {
    out("(no sessions)");
    return;
  }
  for (const item of items) {
    const s = item.session;
    const topic = s.topic ?? "(no topic)";
    const peers = s.participants
      .map((p) => p.handle)
      .filter((h) => h !== item.acting_handle)
      .join(", ");
    out(
      `${s.id}  [${s.state}]  ${item.acting_handle} → ${peers || "(none)"}  ${topic}`,
    );
  }
}
