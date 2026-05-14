import { Command, Option } from "commander";

import { AccountClient } from "../account/client.js";
import type {
  AccountResponse,
  AgentCreate,
  AgentUpdate,
} from "../account/types.js";
import { CapabilityNotSupportedError } from "../agents/errors.js";
import {
  isFullAgentResponse,
  type AgentDetail,
  type AgentDetailResponse,
  type AgentResponse,
  type AgentVisibility,
} from "../agents/types.js";
import { resolveUserToken } from "../asmtp/auth-resolver.js";
import { handleArg } from "../asmtp/handles.js";
import type { Handle, InboundPolicy } from "../asmtp/types.js";
import { discoverOAuth } from "../auth/discovery.js";
import { performPkceLogin } from "../auth/pkce.js";
import type { CLIConfig } from "../config.js";
import { openProcessCredentialStore } from "../credentials/lifecycle.js";
import { RobotNetCLIError } from "../errors.js";
import { renderKeyValues } from "../output/formatters.js";
import { renderJson } from "../output/json-output.js";
import {
  defaultHelpOnBare,
  jsonOption,
  loadConfigFromRoot,
  out,
  profileTitle,
  readStringOrFile,
  scopeOption,
} from "./shared.js";

/**
 * `robotnet account` — operations against the calling **account** (the
 * human user that owns one or more agents on a remote network).
 * Authenticated by the user-session bearer from `robotnet account login`.
 *
 * Subgroups:
 *  - `account login | logout | login show` — bootstrap and inspect the user session.
 *  - `account show | sessions` — account profile and aggregated session list.
 *  - `account agent <verb>` — create/list/show/remove/set agents the
 *    account owns. Mirrors the local-side `admin agent <verb>` group;
 *    different actor, different auth, parallel verb shape.
 *
 * Every command rejects `--network local` with a clear capability error
 * pointing at the local-side equivalent.
 *
 * Distinct from:
 *  - `robotnet me` — the calling agent acting on itself.
 *  - `robotnet admin agent` — local-network agent management.
 *  - `robotnet agents` — directory lookup of any agent.
 */
export function registerAccountCommand(program: Command): void {
  const account = defaultHelpOnBare(
    new Command("account").description(
      "Operations against the calling account (remote networks only)",
    ),
  );

  account.addCommand(makeLoginCmd());
  account.addCommand(makeLogoutCmd());
  account.addCommand(makeShowCmd());
  account.addCommand(makeAccountAgentCommand());

  program.addCommand(account);
}

// ── account login / logout ───────────────────────────────────────────────────

function makeLoginCmd(): Command {
  const login = new Command("login")
    .description("Sign in to the calling account on the resolved network (user PKCE)")
    .addOption(scopeOption())
    .option("--resource <url>", "Override the discovered websocket resource")
    .addOption(jsonOption())
    .action(async (opts: AccountLoginOpts, cmd: Command) => {
      const config = await loadConfigFromRoot(cmd);
      assertOAuthNetwork(config, "account login");

      const discovery = await discoverOAuth(config.network);
      const result = await performPkceLogin({
        network: config.network,
        discovery,
        ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
      });
      const accessTokenExpiresAt =
        result.token.expiresIn !== null
          ? Date.now() + result.token.expiresIn * 1000
          : null;
      const store = await openProcessCredentialStore(config);
      store.putUserSession({
        accessToken: result.token.accessToken,
        refreshToken: result.refreshToken,
        accessTokenExpiresAt,
        scope: result.token.scope,
        clientId: result.clientId,
        tokenEndpoint: result.tokenEndpoint,
        resource: result.token.resource,
        redirectUri: result.redirectUri,
        authMode: "pkce",
      });

      const payload: Record<string, unknown> = {
        signed_in_as: "account",
        client_id: result.clientId,
        expires_at: accessTokenExpiresAt,
        scope: result.token.scope,
      };
      if (opts.json) {
        out(renderJson(payload));
      } else {
        out(renderKeyValues(profileTitle("Account login", config), payload));
      }
    });

  login
    .command("show")
    .description("Show the current account-login state")
    .addOption(jsonOption())
    .action(async (opts: { json: boolean }, cmd: Command) => {
      const config = await loadConfigFromRoot(cmd);
      const store = await openProcessCredentialStore(config);
      const info = store.getUserSessionInfo();
      const payload: Record<string, unknown> = {
        configured: info !== null,
      };
      if (info) {
        payload.auth_mode = info.authMode;
        payload.client_id = info.clientId;
        payload.expires_at = info.accessTokenExpiresAt;
        payload.scope = info.scope;
        payload.token_endpoint = info.tokenEndpoint;
        payload.resource = info.resource;
      }
      if (opts.json) {
        out(renderJson(payload));
      } else {
        out(renderKeyValues(profileTitle("Account login status", config), payload));
      }
    });

  return login;
}

interface AccountLoginOpts {
  readonly scope?: string;
  readonly resource?: string;
  readonly json: boolean;
}

function makeLogoutCmd(): Command {
  return new Command("logout")
    .description("Clear the stored account session")
    .action(async (_opts: object, cmd: Command) => {
      const config = await loadConfigFromRoot(cmd);
      const store = await openProcessCredentialStore(config);
      const removed = store.deleteUserSession();
      out(removed ? "Signed out (account session cleared)." : "Already signed out.");
    });
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

// ── account sessions ─────────────────────────────────────────────────────────

// ── account agent ───────────────────────────────────────────────────────────

function makeAccountAgentCommand(): Command {
  const agent = defaultHelpOnBare(
    new Command("agent").description("Manage agents owned by the calling account"),
  );

  agent.addCommand(makeAgentCreateCmd());
  agent.addCommand(makeAgentListCmd());
  agent.addCommand(makeAgentShowCmd());
  agent.addCommand(makeAgentRemoveCmd());
  agent.addCommand(makeAgentSetCmd());

  return agent;
}

function inboundPolicyOption(): Option {
  return new Option(
    "--inbound-policy <policy>",
    'Inbound trust posture: "allowlist" or "open"',
  ).argParser(parseInboundPolicyArg);
}

function visibilityOption(): Option {
  return new Option(
    "--visibility <visibility>",
    'Visibility: "public" or "private"',
  ).argParser(parseVisibilityArg);
}

// account agent create
function makeAgentCreateCmd(): Command {
  return new Command("create")
    .description("Create a personal agent under the calling account")
    .argument(
      "<handle>",
      "Full agent handle. The owner segment must match your account username (e.g. @nick.bot).",
      handleArg,
    )
    .option("--display-name <text>", "Human-readable display name (1-100 chars)")
    .option(
      "--description <text-or-@file>",
      "Short description, max 500 chars (literal text, or `@<path>` to read from a file)",
    )
    .addOption(visibilityOption())
    .addOption(inboundPolicyOption())
    .option("--json", "Emit machine-readable JSON", false)
    .action(async (handle: Handle, opts: AgentCreateOpts, cmd: Command) => {
      const config = await loadConfigFromRoot(cmd);
      const client = await buildClient(config);
      const local_name = parseLocalName(handle);
      const description =
        opts.description !== undefined
          ? readStringOrFile(opts.description, "--description")
          : undefined;
      const body: AgentCreate = {
        local_name,
        display_name: opts.displayName ?? local_name,
        ...(description !== undefined ? { description } : {}),
        ...(opts.visibility !== undefined ? { visibility: opts.visibility } : {}),
        ...(opts.inboundPolicy !== undefined
          ? { inbound_policy: opts.inboundPolicy }
          : {}),
      };
      const created = await client.createAgent(body);
      if (opts.json) {
        out(renderJson(created));
        return;
      }
      out(`Agent ${created.canonical_handle} created on network "${config.network.name}".`);
      out("To mint a bearer for this agent, run:");
      out(
        `  robotnet login --agent ${created.canonical_handle} --network ${config.network.name}`,
      );
      renderRemoteAgent(created);
    });
}

interface AgentCreateOpts {
  readonly displayName?: string;
  readonly description?: string;
  readonly visibility?: AgentVisibility;
  readonly inboundPolicy?: InboundPolicy;
  readonly json: boolean;
}

// account agent list
function makeAgentListCmd(): Command {
  return new Command("list")
    .description("List agents owned by the calling account")
    .option("--managed", "Include org-managed agents the account can act as", false)
    .option("--query <text>", "Filter by display name or handle (personal only)")
    .option("--limit <n>", "Maximum results (1..100)", parseLimit, 50)
    .option("--json", "Emit machine-readable JSON", false)
    .action(async (opts: AgentListOpts, cmd: Command) => {
      const config = await loadConfigFromRoot(cmd);
      const client = await buildClient(config);
      const result = opts.managed
        ? await client.listManagedAgents()
        : await client.listAgents({
            ...(opts.query !== undefined ? { query: opts.query } : {}),
            limit: opts.limit,
          });
      if (opts.json) {
        out(renderJson(result));
        return;
      }
      if (result.agents.length === 0) {
        out("(no agents)");
        return;
      }
      for (const a of result.agents) {
        const status = a.is_online ? "online" : "offline";
        const flags: string[] = [a.visibility, a.inbound_policy];
        if (a.paused) flags.push("paused");
        if (a.inactive) flags.push("inactive");
        out(`${a.canonical_handle}  ${a.display_name}  [${flags.join(", ")}]  ${status}`);
      }
      if (result.next_cursor !== null) {
        out(`(more — pass --limit higher or use cursor=${result.next_cursor})`);
      }
    });
}

interface AgentListOpts {
  readonly managed: boolean;
  readonly query?: string;
  readonly limit: number;
  readonly json: boolean;
}

// account agent show
function makeAgentShowCmd(): Command {
  return new Command("show")
    .description("Show full details of an agent the account owns")
    .argument("<handle>", "Agent handle", handleArg)
    .option("--json", "Emit machine-readable JSON", false)
    .action(async (handle: Handle, opts: { json: boolean }, cmd: Command) => {
      const config = await loadConfigFromRoot(cmd);
      const client = await buildClient(config);
      const detail = await client.getAgent(handle);
      if (opts.json) {
        out(renderJson(detail));
        return;
      }
      renderRemoteAgentDetail(detail);
    });
}

// account agent remove
function makeAgentRemoveCmd(): Command {
  return new Command("remove")
    .description("Delete an agent owned by the calling account")
    .argument("<handle>", "Agent handle", handleArg)
    .action(async (handle: Handle, _opts: unknown, cmd: Command) => {
      const config = await loadConfigFromRoot(cmd);
      const client = await buildClient(config);
      await client.deleteAgent(handle);
      // Drop any locally-cached bearer for the deleted agent so a stale
      // credential doesn't survive removal.
      const store = await openProcessCredentialStore(config);
      store.deleteAgentCredential(config.network.name, handle);
      out(`Removed ${handle}.`);
    });
}

// account agent set
function makeAgentSetCmd(): Command {
  return new Command("set")
    .description("Update settings for an agent the account owns")
    .argument("<handle>", "Agent handle", handleArg)
    .option("--display-name <text>", "New display name")
    .option(
      "--description <text-or-@file>",
      "New description (literal text, or `@<path>` to read from a file; empty string clears)",
    )
    .option(
      "--card-body <markdown-or-@file>",
      "New card body (literal markdown, or `@<path>` to read from a file; empty string clears)",
    )
    .addOption(visibilityOption())
    .addOption(inboundPolicyOption())
    .option("--paused", "Pause the agent (refuses inbound sessions)")
    .option("--unpaused", "Unpause the agent")
    .option("--json", "Emit machine-readable JSON", false)
    .action(async (handle: Handle, opts: AgentSetOpts, cmd: Command) => {
      const update: { -readonly [K in keyof AgentUpdate]: AgentUpdate[K] } = {};
      if (opts.displayName !== undefined) update.display_name = opts.displayName;
      if (opts.description !== undefined) {
        const resolved = readStringOrFile(opts.description, "--description");
        update.description = resolved.length > 0 ? resolved : null;
      }
      if (opts.cardBody !== undefined) {
        const resolved = readStringOrFile(opts.cardBody, "--card-body");
        update.card_body = resolved.length > 0 ? resolved : null;
      }
      if (opts.visibility !== undefined) update.visibility = opts.visibility;
      if (opts.inboundPolicy !== undefined) {
        update.inbound_policy = opts.inboundPolicy;
      }
      if (opts.paused === true) update.paused = true;
      if (opts.unpaused === true) update.paused = false;
      if (Object.keys(update).length === 0) {
        throw new RobotNetCLIError(
          "Nothing to update. Provide at least one of --display-name, --description, " +
            "--card-body, --visibility, --inbound-policy, --paused, --unpaused.",
        );
      }
      if (opts.paused === true && opts.unpaused === true) {
        throw new RobotNetCLIError("Pass at most one of --paused / --unpaused.");
      }
      const config = await loadConfigFromRoot(cmd);
      const client = await buildClient(config);
      const updated = await client.updateAgent(handle, update);
      if (opts.json) {
        out(renderJson(updated));
        return;
      }
      out(`Updated ${updated.canonical_handle}.`);
      renderRemoteAgent(updated);
    });
}

interface AgentSetOpts {
  readonly displayName?: string;
  readonly description?: string;
  readonly cardBody?: string;
  readonly visibility?: AgentVisibility;
  readonly inboundPolicy?: InboundPolicy;
  readonly paused?: boolean;
  readonly unpaused?: boolean;
  readonly json: boolean;
}

function parseInboundPolicyArg(value: string): InboundPolicy {
  if (value !== "allowlist" && value !== "open") {
    throw new RobotNetCLIError(
      `invalid policy "${value}" — expected "allowlist" or "open"`,
    );
  }
  return value;
}

function parseVisibilityArg(value: string): AgentVisibility {
  if (value !== "public" && value !== "private") {
    throw new RobotNetCLIError(
      `invalid visibility "${value}" — expected "public" or "private"`,
    );
  }
  return value;
}

function parseLocalName(handle: Handle): string {
  const dot = handle.indexOf(".");
  if (dot < 0) {
    throw new RobotNetCLIError(`handle "${handle}" missing the local-name segment`);
  }
  return handle.slice(dot + 1);
}

function renderRemoteAgent(agent: AgentResponse): void {
  out(`  Handle:       ${agent.canonical_handle}`);
  out(`  Display name: ${agent.display_name}`);
  out(`  Visibility:   ${agent.visibility}`);
  out(`  Inbound:      ${agent.inbound_policy}`);
  if (agent.paused) out("  Paused:       true");
  if (agent.description !== null && agent.description.length > 0) {
    out(`  Description:  ${agent.description}`);
  }
}

function renderRemoteAgentDetail(detail: AgentDetailResponse): void {
  renderRemoteAgentSummary(detail.agent);
}

function renderRemoteAgentSummary(detail: AgentDetail): void {
  out(`  Handle:       ${detail.canonical_handle}`);
  out(`  Display name: ${detail.display_name}`);
  out(`  Visibility:   ${detail.visibility}`);
  out(`  Inbound:      ${detail.inbound_policy}`);
  if (detail.description !== null && detail.description.length > 0) {
    out(`  Description:  ${detail.description}`);
  }
  if (!isFullAgentResponse(detail)) return;
  if (detail.paused) out("  Paused:       true");
}

// ── shared helpers ───────────────────────────────────────────────────────────

async function buildClient(config: CLIConfig): Promise<AccountClient> {
  assertOAuthNetwork(config, "account operations");
  const { token } = await resolveUserToken(config);
  return new AccountClient(config.network.url, token, config.network.name);
}

function assertOAuthNetwork(config: CLIConfig, capability: string): void {
  if (config.network.authMode === "oauth") return;
  throw new CapabilityNotSupportedError(config.network.name, capability);
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

