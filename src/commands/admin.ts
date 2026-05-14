import { Command, Option } from "commander";

import { resolveAdminClient } from "../asmtp/auth-resolver.js";
import { handleArg } from "../asmtp/handles.js";
import type {
  AgentVisibility,
  AgentWire,
  AgentWithTokenWire,
  Handle,
  InboundPolicy,
} from "../asmtp/types.js";
import type { CLIConfig } from "../config.js";
import { openProcessCredentialStore } from "../credentials/lifecycle.js";
import { CapabilityNotSupportedError } from "../agents/errors.js";
import { RobotNetCLIError } from "../errors.js";
import { renderJson } from "../output/json-output.js";
import { loadConfigFromRoot, out } from "./shared.js";

/**
 * `robotnet admin ...` — local-only operations authenticated by
 * `local_admin_token`. Today this group hosts agent management for the
 * local network (`admin agent <verb>`); operator lifecycle commands live
 * under the sibling `network` group.
 *
 * Every admin command rejects remote networks with a clear capability
 * error: the user only ever has admin authority on a network they
 * themselves run. Account-owned agents on a remote network are managed
 * via `robotnet account agent <verb>`.
 */
export function registerAdminCommand(program: Command): void {
  const admin = new Command("admin").description(
    "Local-network admin commands (authenticated by local_admin_token)",
  );

  admin.addCommand(makeAdminAgentCommand());

  program.addCommand(admin);
}

// ── admin agent ─────────────────────────────────────────────────────────────

function makeAdminAgentCommand(): Command {
  const agent = new Command("agent").description(
    "Manage agents on a local network",
  );

  agent.addCommand(makeCreateCmd());
  agent.addCommand(makeListCmd());
  agent.addCommand(makeShowCmd());
  agent.addCommand(makeRemoveCmd());
  agent.addCommand(makeSetCmd());
  agent.addCommand(makeRotateTokenCmd());

  return agent;
}

function localAdminTokenOption(): Option {
  return new Option(
    "--local-admin-token <token>",
    "Override the stored local admin token (escape hatch — usually written by `robotnet network start`)",
  );
}

function jsonOption(): Option {
  return new Option("--json", "Emit machine-readable JSON").default(false);
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
    'Visibility: "public" (discoverable) or "private" (only allowlisted peers)',
  ).argParser(parseVisibilityArg);
}

interface CommonOpts {
  readonly localAdminToken?: string;
  readonly json: boolean;
}

// ── create ──────────────────────────────────────────────────────────────────

function makeCreateCmd(): Command {
  return new Command("create")
    .description("Create a new agent on the local network")
    .argument("<handle>", "Agent handle (e.g. @nick.bot)", handleArg)
    .option("--display-name <text>", "Display name (defaults to the handle)")
    .option("--description <text>", "Short description")
    .option("--card-body <markdown>", "Card body (markdown)")
    .addOption(visibilityOption())
    .addOption(inboundPolicyOption())
    .addOption(localAdminTokenOption())
    .addOption(jsonOption())
    .action(async (handle: Handle, opts: CreateOpts, cmd: Command) => {
      const config = await loadConfigFromRoot(cmd);
      assertLocalNetwork(config, "admin agent create");
      const client = await resolveAdminClient(config, opts.localAdminToken);
      const created = await client.registerAgent(handle, {
        ...(opts.inboundPolicy !== undefined ? { policy: opts.inboundPolicy } : {}),
        ...(opts.displayName !== undefined ? { displayName: opts.displayName } : {}),
        ...(opts.description !== undefined ? { description: opts.description } : {}),
        ...(opts.cardBody !== undefined ? { cardBody: opts.cardBody } : {}),
        ...(opts.visibility !== undefined ? { visibility: opts.visibility } : {}),
      });
      // Persist the freshly-minted local_bearer so subsequent `me`,
      // `session`, and `listen` commands for this handle work without an
      // additional auth step.
      const store = await openProcessCredentialStore(config);
      store.putAgentCredential({
        networkName: config.network.name,
        handle,
        kind: "local_bearer",
        bearer: created.token,
      });
      if (opts.json) {
        out(renderJson(created));
        return;
      }
      out(`Agent created on local network "${config.network.name}".`);
      renderLocalAgent(created);
    });
}

interface CreateOpts extends CommonOpts {
  readonly inboundPolicy?: InboundPolicy;
  readonly displayName?: string;
  readonly description?: string;
  readonly cardBody?: string;
  readonly visibility?: AgentVisibility;
}

// ── list ────────────────────────────────────────────────────────────────────

function makeListCmd(): Command {
  return new Command("list")
    .description("List every agent on the local network")
    .addOption(localAdminTokenOption())
    .addOption(jsonOption())
    .action(async (opts: CommonOpts, cmd: Command) => {
      const config = await loadConfigFromRoot(cmd);
      assertLocalNetwork(config, "admin agent list");
      const client = await resolveAdminClient(config, opts.localAdminToken);
      const agents = await client.listAgents();
      if (opts.json) {
        out(renderJson({ agents }));
        return;
      }
      if (agents.length === 0) {
        out("(no agents)");
        return;
      }
      for (const a of agents) {
        // Skip display_name when it's the handle fallback (operator omitted
        // it and the client normalized to handle). Avoids `@x.bot @x.bot ...`.
        const name = a.display_name === a.handle ? "" : `  ${a.display_name}`;
        out(
          `${a.handle}${name}  ` +
            `[${a.visibility}, ${a.policy}]  ` +
            `allowlist=${a.allowlist.length}`,
        );
      }
    });
}

// ── show ────────────────────────────────────────────────────────────────────

function makeShowCmd(): Command {
  return new Command("show")
    .description("Show full details of an agent on the local network")
    .argument("<handle>", "Agent handle", handleArg)
    .addOption(localAdminTokenOption())
    .addOption(jsonOption())
    .action(async (handle: Handle, opts: CommonOpts, cmd: Command) => {
      const config = await loadConfigFromRoot(cmd);
      assertLocalNetwork(config, "admin agent show");
      const client = await resolveAdminClient(config, opts.localAdminToken);
      const agent = await client.showAgent(handle);
      if (opts.json) {
        out(renderJson(agent));
        return;
      }
      renderLocalAgent(agent);
    });
}

// ── remove ──────────────────────────────────────────────────────────────────

function makeRemoveCmd(): Command {
  return new Command("remove")
    .description("Delete an agent from the local network")
    .argument("<handle>", "Agent handle", handleArg)
    .addOption(localAdminTokenOption())
    .action(
      async (handle: Handle, opts: { localAdminToken?: string }, cmd: Command) => {
        const config = await loadConfigFromRoot(cmd);
        assertLocalNetwork(config, "admin agent remove");
        const client = await resolveAdminClient(config, opts.localAdminToken);
        await client.removeAgent(handle);
        // Drop any locally-cached bearer for the deleted agent so a stale
        // credential doesn't survive removal.
        const store = await openProcessCredentialStore(config);
        store.deleteAgentCredential(config.network.name, handle);
        out(`Removed ${handle} from local network "${config.network.name}".`);
      },
    );
}

// ── set ─────────────────────────────────────────────────────────────────────

function makeSetCmd(): Command {
  return new Command("set")
    .description("Update an agent's settings on the local network")
    .argument("<handle>", "Agent handle", handleArg)
    .option("--display-name <text>", "New display name")
    .option("--description <text>", "New description (empty string clears)")
    .option("--card-body <markdown>", "New card body (empty string clears)")
    .addOption(visibilityOption())
    .addOption(inboundPolicyOption())
    .addOption(localAdminTokenOption())
    .addOption(jsonOption())
    .action(async (handle: Handle, opts: SetOpts, cmd: Command) => {
      const config = await loadConfigFromRoot(cmd);
      assertLocalNetwork(config, "admin agent set");
      const update = buildSetPayload(opts);
      if (Object.keys(update).length === 0) {
        throw new RobotNetCLIError(
          "Nothing to update. Provide at least one of --display-name, --description, " +
            "--card-body, --visibility, --inbound-policy.",
        );
      }
      const client = await resolveAdminClient(config, opts.localAdminToken);
      const updated = await client.updateAgent(handle, update);
      if (opts.json) {
        out(renderJson(updated));
        return;
      }
      out(`Updated ${handle}.`);
      renderLocalAgent(updated);
    });
}

interface SetOpts extends CommonOpts {
  readonly inboundPolicy?: InboundPolicy;
  readonly displayName?: string;
  readonly description?: string;
  readonly cardBody?: string;
  readonly visibility?: AgentVisibility;
}

/**
 * Translate parsed `set` flags into the AdminAgentUpdateInput shape.
 * Empty-string `--description` / `--card-body` is honored as a clear
 * (sent as `null`); everything else passes through verbatim.
 */
function buildSetPayload(opts: SetOpts): {
  policy?: InboundPolicy;
  displayName?: string;
  description?: string | null;
  cardBody?: string | null;
  visibility?: AgentVisibility;
} {
  const update: {
    policy?: InboundPolicy;
    displayName?: string;
    description?: string | null;
    cardBody?: string | null;
    visibility?: AgentVisibility;
  } = {};
  if (opts.inboundPolicy !== undefined) update.policy = opts.inboundPolicy;
  if (opts.displayName !== undefined) update.displayName = opts.displayName;
  if (opts.description !== undefined) {
    update.description = opts.description.length > 0 ? opts.description : null;
  }
  if (opts.cardBody !== undefined) {
    update.cardBody = opts.cardBody.length > 0 ? opts.cardBody : null;
  }
  if (opts.visibility !== undefined) update.visibility = opts.visibility;
  return update;
}

// ── rotate-token ────────────────────────────────────────────────────────────

function makeRotateTokenCmd(): Command {
  return new Command("rotate-token")
    .description("Mint a new bearer for an agent on the local network")
    .argument("<handle>", "Agent handle", handleArg)
    .addOption(localAdminTokenOption())
    .addOption(jsonOption())
    .action(async (handle: Handle, opts: CommonOpts, cmd: Command) => {
      const config = await loadConfigFromRoot(cmd);
      assertLocalNetwork(config, "admin agent rotate-token");
      const client = await resolveAdminClient(config, opts.localAdminToken);
      const rotated = await client.rotateToken(handle);
      const store = await openProcessCredentialStore(config);
      store.putAgentCredential({
        networkName: config.network.name,
        handle,
        kind: "local_bearer",
        bearer: rotated.token,
      });
      if (opts.json) {
        out(renderJson(rotated));
        return;
      }
      out(`Token rotated for ${handle}.`);
      renderLocalAgent(rotated);
    });
}

// ── shared helpers ──────────────────────────────────────────────────────────

/**
 * Reject `--network <remote>` for admin commands. The error message
 * points the user at the `account agent <verb>` analog so they don't
 * have to discover it from `--help`.
 */
function assertLocalNetwork(config: CLIConfig, capability: string): void {
  if (config.network.authMode === "agent-token") return;
  throw new CapabilityNotSupportedError(
    config.network.name,
    `${capability} (admin commands are local-only — for remote networks ` +
      `use \`robotnet account agent <verb>\` instead)`,
  );
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

function renderLocalAgent(agent: AgentWire | AgentWithTokenWire): void {
  const pad = 13;
  out(`  ${"handle".padEnd(pad)} ${agent.handle}`);
  // Skip display_name when it's the handle fallback (see normalizeAgentWire).
  if (agent.display_name !== agent.handle) {
    out(`  ${"display name".padEnd(pad)} ${agent.display_name}`);
  }
  out(`  ${"policy".padEnd(pad)} ${agent.policy}`);
  out(`  ${"visibility".padEnd(pad)} ${agent.visibility}`);
  if (agent.description !== null && agent.description.length > 0) {
    out(`  ${"description".padEnd(pad)} ${agent.description}`);
  }
  if ("token" in agent && typeof agent.token === "string") {
    out(`  ${"token".padEnd(pad)} ${agent.token}`);
  }
  out(
    `  ${"allowlist".padEnd(pad)} ${
      agent.allowlist.length === 0
        ? "(empty)"
        : `${agent.allowlist.length} — ${[...agent.allowlist].join(", ")}`
    }`,
  );
  if (agent.card_body !== null && agent.card_body.length > 0) {
    out("  card");
    for (const line of agent.card_body.split("\n")) {
      out(`    ${line}`);
    }
  }
}
