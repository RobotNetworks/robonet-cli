import { Command } from "commander";

import { resolveAdminClient } from "../asp/auth-resolver.js";
import { handleArg } from "../asp/handles.js";
import type { AgentWire, InboundPolicy } from "../asp/types.js";
import { openProcessCredentialStore } from "../credentials/lifecycle.js";
import { RobotNetCLIError } from "../errors.js";
import { loadConfigFromRoot, out } from "./asp-shared.js";

/**
 * `robotnet agent` — manage agents on an ASP network.
 *
 * Mirrors the agent-management surface of the `asp` CLI minus `list`, which
 * is a network-wide read that belongs in the RobotNet web/desktop app, not
 * here.
 *
 * Each leaf command authenticates with the admin token. Resolution order:
 *   1. `--admin-token <tok>` flag (explicit dev escape hatch)
 *   2. `<state>/networks/<network>/admin.token` (written by the desktop app's
 *      supervisor; later: read from the shared SQLite credential store)
 */
export function registerAgentCommand(program: Command): void {
  const agent = new Command("agent").description(
    "Manage agents on an ASP network",
  );

  agent.addCommand(makeRegisterCmd());
  agent.addCommand(makeShowCmd());
  agent.addCommand(makeRmCmd());
  agent.addCommand(makeRotateTokenCmd());
  agent.addCommand(makeSetPolicyCmd());

  program.addCommand(agent);
}

function makeRegisterCmd(): Command {
  return new Command("register")
    .description("Register a new agent on the network")
    .argument("<handle>", "Agent handle (e.g. @cli.bot)", handleArg)
    .option(
      "--policy <policy>",
      'Inbound trust posture: "allowlist" (default) or "open"',
      parsePolicyArg,
    )
    .addOption(adminTokenOption())
    .option("--json", "Emit machine-readable JSON", false)
    .action(
      async (
        handle: string,
        opts: AgentLeafOpts & { policy?: InboundPolicy },
        cmd: Command,
      ) => {
        const config = loadConfigFromRoot(cmd);
        const client = await resolveAdminClient(config, opts.adminToken);
        const agent = await client.registerAgent(
          handle,
          opts.policy !== undefined ? { policy: opts.policy } : {},
        );
        // Persist the agent's bearer so subsequent session/listen commands
        // for this handle don't need --token.
        const store = await openProcessCredentialStore(config);
        store.putAgentCredential({
          networkName: config.network.name,
          handle,
          kind: "local_bearer",
          bearer: agent.token,
        });
        renderAgent(agent, opts.json, `Agent registered on network "${config.network.name}".`);
      },
    );
}

function makeShowCmd(): Command {
  return new Command("show")
    .description("Show details for a single agent")
    .argument("<handle>", "Agent handle", handleArg)
    .addOption(adminTokenOption())
    .option("--json", "Emit machine-readable JSON", false)
    .action(async (handle: string, opts: AgentLeafOpts, cmd: Command) => {
      const config = loadConfigFromRoot(cmd);
      const client = await resolveAdminClient(config, opts.adminToken);
      const agent = await client.showAgent(handle);
      renderAgent(agent, opts.json);
    });
}

function makeRmCmd(): Command {
  return new Command("rm")
    .description("Remove an agent from the network")
    .argument("<handle>", "Agent handle", handleArg)
    .addOption(adminTokenOption())
    .action(async (handle: string, opts: AgentLeafOpts, cmd: Command) => {
      const config = loadConfigFromRoot(cmd);
      const client = await resolveAdminClient(config, opts.adminToken);
      await client.removeAgent(handle);
      // Drop the local credential so a stale token doesn't survive removal.
      const store = await openProcessCredentialStore(config);
      store.deleteAgentCredential(config.network.name, handle);
      out(`Removed agent ${handle} from network "${config.network.name}".`);
    });
}

function makeRotateTokenCmd(): Command {
  return new Command("rotate-token")
    .description("Issue a new bearer token for an agent")
    .argument("<handle>", "Agent handle", handleArg)
    .addOption(adminTokenOption())
    .option("--json", "Emit machine-readable JSON", false)
    .action(async (handle: string, opts: AgentLeafOpts, cmd: Command) => {
      const config = loadConfigFromRoot(cmd);
      const client = await resolveAdminClient(config, opts.adminToken);
      const agent = await client.rotateToken(handle);
      // Update the local credential to match the freshly-rotated token.
      const store = await openProcessCredentialStore(config);
      store.putAgentCredential({
        networkName: config.network.name,
        handle,
        kind: "local_bearer",
        bearer: agent.token,
      });
      renderAgent(agent, opts.json, `Token rotated for ${handle}.`);
    });
}

function makeSetPolicyCmd(): Command {
  return new Command("set-policy")
    .description("Update the inbound trust policy for an agent")
    .argument("<handle>", "Agent handle", handleArg)
    .argument("<policy>", '"allowlist" or "open"', parsePolicyArg)
    .addOption(adminTokenOption())
    .option("--json", "Emit machine-readable JSON", false)
    .action(
      async (
        handle: string,
        policy: InboundPolicy,
        opts: AgentLeafOpts,
        cmd: Command,
      ) => {
        const config = loadConfigFromRoot(cmd);
        const client = await resolveAdminClient(config, opts.adminToken);
        const agent = await client.setPolicy(handle, policy);
        renderAgent(agent, opts.json, `Policy updated for ${handle}.`);
      },
    );
}

interface AgentLeafOpts {
  readonly adminToken?: string;
  readonly json?: boolean;
}

function adminTokenOption() {
  return new Command().createOption(
    "--admin-token <token>",
    "Override the stored admin token (escape hatch — usually written by the desktop app's network supervisor)",
  );
}

function parsePolicyArg(value: string): InboundPolicy {
  if (value !== "allowlist" && value !== "open") {
    throw new RobotNetCLIError(
      `invalid policy "${value}" — expected "allowlist" or "open"`,
    );
  }
  return value;
}

function renderAgent(
  agent: AgentWire,
  json: boolean | undefined,
  header?: string,
): void {
  if (json) {
    out(JSON.stringify(agent, null, 2));
    return;
  }
  if (header) out(header);
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
