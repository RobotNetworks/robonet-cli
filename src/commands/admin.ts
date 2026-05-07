import { Command, Option } from "commander";

import { resolveAdminClient } from "../asp/auth-resolver.js";
import { handleArg } from "../asp/handles.js";
import type {
  AgentWire,
  AgentWithTokenWire,
  Handle,
  InboundPolicy,
} from "../asp/types.js";
import type { CLIConfig } from "../config.js";
import { openProcessCredentialStore } from "../credentials/lifecycle.js";
import { CapabilityNotSupportedError } from "../agents/errors.js";
import { RobotNetCLIError } from "../errors.js";
import { renderJson } from "../output/json-output.js";
import { loadConfigFromRoot, out } from "./asp-shared.js";

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

interface CommonOpts {
  readonly localAdminToken?: string;
  readonly json: boolean;
}

// ── create ──────────────────────────────────────────────────────────────────

function makeCreateCmd(): Command {
  return new Command("create")
    .description("Create a new agent on the local network")
    .argument("<handle>", "Agent handle (e.g. @nick.bot)", handleArg)
    .addOption(inboundPolicyOption())
    .addOption(localAdminTokenOption())
    .addOption(jsonOption())
    .action(async (handle: Handle, opts: CreateOpts, cmd: Command) => {
      const config = await loadConfigFromRoot(cmd);
      assertLocalNetwork(config, "admin agent create");
      const client = await resolveAdminClient(config, opts.localAdminToken);
      const created = await client.registerAgent(
        handle,
        opts.inboundPolicy !== undefined ? { policy: opts.inboundPolicy } : {},
      );
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
        out(`${a.handle}  policy=${a.policy}  allowlist=${a.allowlist.length}`);
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
    .addOption(inboundPolicyOption())
    .addOption(localAdminTokenOption())
    .addOption(jsonOption())
    .action(async (handle: Handle, opts: SetOpts, cmd: Command) => {
      const config = await loadConfigFromRoot(cmd);
      assertLocalNetwork(config, "admin agent set");
      if (opts.inboundPolicy === undefined) {
        throw new RobotNetCLIError(
          "Nothing to update. The only field local agents support is `--inbound-policy`.",
        );
      }
      const client = await resolveAdminClient(config, opts.localAdminToken);
      const updated = await client.setPolicy(handle, opts.inboundPolicy);
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

function renderLocalAgent(agent: AgentWire | AgentWithTokenWire): void {
  const pad = 9;
  out(`  ${"handle".padEnd(pad)} ${agent.handle}`);
  out(`  ${"policy".padEnd(pad)} ${agent.policy}`);
  if ("token" in agent && typeof agent.token === "string") {
    out(`  ${"token".padEnd(pad)} ${agent.token}`);
  }
  if (agent.allowlist.length > 0) {
    out(`  ${"allowlist".padEnd(pad)} ${[...agent.allowlist].join(", ")}`);
  }
}
