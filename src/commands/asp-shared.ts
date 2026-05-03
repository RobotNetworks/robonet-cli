import type { Command } from "commander";

import { loadConfig, type CLIConfig } from "../config.js";
import { RobotNetCLIError } from "../errors.js";
import {
  findDirectoryIdentity,
  resolveAgentIdentity,
  type ResolvedAgentIdentity,
} from "../asp/identity.js";

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
 */
export function loadConfigFromRoot(cmd: Command): CLIConfig {
  const opts = rootOpts(cmd);
  return loadConfig(opts.profile, { networkName: opts.network });
}

/**
 * Resolve config + acting agent for a command that needs both (session, listen, …).
 *
 * Behaves like {@link loadConfigFromRoot} except: when no `--network` flag is set
 * but a directory `.robotnet/asp.json` exists, the directory identity's network
 * drives the config — so `robotnet session list` from a project dir targets the
 * network the project pinned, not the global default. The `--network` flag,
 * `ROBOTNET_NETWORK`, and other top-level resolution sources still win when set.
 *
 * Throws {@link RobotNetCLIError} when no agent identity can be resolved
 * (no `--as`, no `ROBOTNET_AGENT`, no directory file).
 */
export async function loadConfigForAgentCommand(
  cmd: Command,
  explicitHandle: string | undefined,
): Promise<{ config: CLIConfig; identity: ResolvedAgentIdentity }> {
  const opts = rootOpts(cmd);

  let networkOverride = opts.network;
  if (networkOverride === undefined) {
    const dir = await findDirectoryIdentity();
    if (dir !== undefined) networkOverride = dir.network;
  }

  const config = loadConfig(opts.profile, { networkName: networkOverride });

  const identity = await resolveAgentIdentity({
    explicitHandle,
    resolvedNetwork: config.network.name,
  });
  if (!identity) {
    throw new RobotNetCLIError(
      "no agent specified. Pass --as <handle>, set ROBOTNET_AGENT, " +
        "or bind a directory identity with `robotnet identity set`.",
    );
  }
  return { config, identity };
}

/** Write a line to stdout (newline-terminated), matching the asp CLI's output style. */
export function out(line: string): void {
  process.stdout.write(`${line}\n`);
}
