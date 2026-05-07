import type { Command } from "commander";

import {
  findDirectoryIdentityFile,
  resolveAgentIdentity,
  type ResolvedAgentIdentity,
} from "../asp/identity.js";
import { loadConfig, type CLIConfig } from "../config.js";
import { RobotNetCLIError } from "../errors.js";

interface RootOpts {
  readonly profile?: string;
  readonly network?: string;
}

function rootOpts(cmd: Command): RootOpts {
  let root: Command | null = cmd;
  while (root?.parent) {
    root = root.parent;
  }
  return (root?.opts() ?? {}) as RootOpts;
}

/**
 * Resolve the active {@link CLIConfig} from inside a (possibly nested)
 * commander action handler. Walks up `cmd.parent` chains so it doesn't
 * matter whether the caller is a top-level or grouped sub-command.
 *
 * The directory's network pin lives in the workspace
 * `.robotnet/config.json` `network` field, which `loadConfig` reads
 * directly — no extra plumbing needed here.
 */
export async function loadConfigFromRoot(cmd: Command): Promise<CLIConfig> {
  const opts = rootOpts(cmd);
  return loadConfig(opts.profile, { networkName: opts.network });
}

/**
 * Resolve config + acting agent for a command that needs both (session, listen, …).
 *
 * Throws {@link RobotNetCLIError} when no agent identity can be resolved.
 * The error message is enriched when the workspace *would* have bound an
 * agent but the resolved network differs from the workspace's pinned
 * network — this is the most common foot-gun (`--network <other>` from
 * inside a workspace pinned to something else), and naming both sources
 * concretely is a lot more useful than a generic "no agent" line.
 */
export async function loadConfigForAgentCommand(
  cmd: Command,
  explicitHandle: string | undefined,
): Promise<{ config: CLIConfig; identity: ResolvedAgentIdentity }> {
  const config = await loadConfigFromRoot(cmd);

  const identity = await resolveAgentIdentity({
    explicitHandle,
    resolvedNetwork: config.network.name,
  });
  if (identity) return { config, identity };

  throw new RobotNetCLIError(await buildNoAgentError(config));
}

async function buildNoAgentError(config: CLIConfig): Promise<string> {
  const networkName = config.network.name;
  const baseHint =
    `Pass --as <handle> on the subcommand (e.g. \`robotnet me show --as <handle>\`), ` +
    `set ROBOTNET_AGENT, ` +
    `or bind one with \`robotnet identity set\` (run inside the directory).`;

  // Detect the misalignment case: workspace has an agent bound to one
  // network, but the command resolved to a different network (typically
  // because of --network or ROBOTNET_NETWORK).
  const file = await findDirectoryIdentityFile();
  if (
    file !== undefined &&
    file.agent !== undefined &&
    file.network !== undefined &&
    file.network !== networkName
  ) {
    const networkSourceLabel = describeNetworkSource(config);
    return (
      `no agent specified for network "${networkName}".\n` +
      `  workspace at ${file.filePath} binds ${file.agent} on network "${file.network}", ` +
      `but the resolved network is "${networkName}" (${networkSourceLabel}).\n` +
      `  fix: pass \`--as <handle>\` on the subcommand (e.g. \`robotnet me show --as <handle> --network ${networkName}\`), ` +
      `drop the network override to use the workspace's "${file.network}", ` +
      `or run \`robotnet identity set <handle>\` after changing into a directory pinned to "${networkName}".`
    );
  }

  return `no agent specified for network "${networkName}". ${baseHint}`;
}

function describeNetworkSource(config: CLIConfig): string {
  switch (config.networkSource.kind) {
    case "flag":
      return "from --network flag";
    case "env":
      return "from ROBOTNET_NETWORK env var";
    case "workspace":
      return `from workspace ${config.networkSource.configFile}`;
    case "default":
      return "built-in default";
  }
}

/** Write a line to stdout (newline-terminated), matching the asp CLI's output style. */
export function out(line: string): void {
  process.stdout.write(`${line}\n`);
}
