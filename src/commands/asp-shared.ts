import type { Command } from "commander";

import {
  findDirectoryIdentityFile,
  resolveAgentIdentity,
  type ResolvedAgentIdentity,
} from "../asp/identity.js";
import { loadConfig, type CLIConfig, type LoadConfigOptions } from "../config.js";
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
 * The directory identity file's `default_network` field, if present, is
 * fed into the network-resolution chain at its proper tier (after env and
 * workspace `config.json`, before profile and built-in defaults). Reading
 * the file here keeps `loadConfig` itself free of `asp/` dependencies.
 */
export async function loadConfigFromRoot(cmd: Command): Promise<CLIConfig> {
  const opts = rootOpts(cmd);
  const directoryIdentityDefault = await readDirectoryIdentityDefault();
  return loadConfig(opts.profile, {
    networkName: opts.network,
    ...(directoryIdentityDefault !== undefined
      ? { directoryIdentityDefault }
      : {}),
  });
}

/**
 * Resolve config + acting agent for a command that needs both (session, listen, …).
 *
 * The acting agent is resolved by {@link resolveAgentIdentity} against the
 * already-resolved network: the directory identity file's per-network
 * `identities` map is consulted using `config.network.name`, so a
 * directory bound to `@me.dev` on `local` does not contribute to a command
 * that has resolved to `robotnet`.
 *
 * Throws {@link RobotNetCLIError} when no agent identity can be resolved
 * (no `--as`, no `ROBOTNET_AGENT`, no directory entry for the resolved network).
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
  if (!identity) {
    throw new RobotNetCLIError(
      `no agent specified for network "${config.network.name}". ` +
        `Pass --as <handle>, set ROBOTNET_AGENT, ` +
        `or bind one with \`robotnet identity set\` (run inside the directory).`,
    );
  }
  return { config, identity };
}

async function readDirectoryIdentityDefault(): Promise<
  LoadConfigOptions["directoryIdentityDefault"] | undefined
> {
  const file = await findDirectoryIdentityFile();
  if (file === undefined || file.defaultNetwork === undefined) return undefined;
  return { network: file.defaultNetwork, filePath: file.filePath };
}

/** Write a line to stdout (newline-terminated), matching the asp CLI's output style. */
export function out(line: string): void {
  process.stdout.write(`${line}\n`);
}
