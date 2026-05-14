import { Command, Option } from "commander";
import * as fs from "node:fs";
import * as readline from "node:readline";

import {
  findDirectoryIdentityFile,
  resolveAgentIdentity,
  type ResolvedAgentIdentity,
} from "../asmtp/identity.js";
import { loadConfig, type CLIConfig } from "../config.js";
import { RobotNetCLIError } from "../errors.js";

// ── Option factories ─────────────────────────────────────────────────

export function clientIdOption(): Option {
  return new Option("--client-id <id>", "Robot Networks client ID");
}
export function clientSecretOption(): Option {
  return new Option("--client-secret <secret>", "Robot Networks client secret");
}
export function scopeOption(): Option {
  // No `.default(...)`: the right scope set depends on whether the
  // command runs in user or agent mode. Leaving this undefined lets each
  // entrypoint (`performPkceLogin`, `performAgentPkceLogin`, etc.) fall
  // through to its own bucket-appropriate default.
  return new Option("--scope <scope>", "OAuth scopes");
}
export function jsonOption(): Option {
  return new Option("--json", "Output as JSON").default(false);
}
export function tokenOption(): Option {
  return new Option(
    "--token <token>",
    "Override the stored agent bearer token (escape hatch)",
  );
}

// ── Display helpers ──────────────────────────────────────────────────

export function profileTitle(title: string, config: CLIConfig): string {
  return `${title} [profile=${config.profile}]`;
}

// ── Prompt helpers ───────────────────────────────────────────────────

export function promptText(label: string, defaultValue?: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  const prompt = defaultValue ? `${label} [${defaultValue}]: ` : `${label}: `;
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      const trimmed = answer.trim();
      resolve(trimmed || defaultValue || "");
    });
  });
}

export function promptSecret(label: string): Promise<string> {
  return new Promise((resolve) => {
    process.stderr.write(`${label}: `);
    const stdin = process.stdin;
    const wasTTY = stdin.isTTY;
    if (wasTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf-8");

    let input = "";
    const onData = (ch: string) => {
      if (ch === "\n" || ch === "\r" || ch === "\u0004") {
        if (wasTTY) stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener("data", onData);
        process.stderr.write("\n");
        resolve(input.trim());
      } else if (ch === "\u0003") {
        if (wasTTY) stdin.setRawMode(false);
        process.exit(130);
      } else if (ch === "\u007f" || ch === "\b") {
        input = input.slice(0, -1);
      } else {
        input += ch;
      }
    };
    stdin.on("data", onData);
  });
}

// ── Credential resolution ────────────────────────────────────────────

export async function resolveClientId(
  provided: string | undefined,
  defaultValue?: string,
): Promise<string> {
  if (provided) return provided;
  return promptText("Robot Networks client ID", defaultValue);
}

export async function resolveClientSecret(
  provided: string | undefined,
): Promise<string> {
  if (provided) return provided;
  return promptSecret("Robot Networks client secret");
}

// ── Config + identity resolution helpers ──────────────────────────────

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
 * Resolve config + acting agent for a command that needs both (send, inbox,
 * listen, files, …).
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

/** Write a line to stdout (newline-terminated). */
export function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

// ── @file argument convention ────────────────────────────────────────

/**
 * Resolve a flag value that may be either a literal string or an `@<path>`
 * reference to a UTF-8 file. Matches the convention used by `send --data`.
 *
 * Empty string is preserved (callers that interpret it as "clear" still do so);
 * `@` alone is rejected so users see a clear error rather than a read of `.`.
 */
export function readStringOrFile(value: string, flag: string): string {
  if (!value.startsWith("@")) return value;
  const filePath = value.slice(1);
  if (filePath.length === 0) {
    throw new RobotNetCLIError(`${flag} '@' must be followed by a file path`);
  }
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new RobotNetCLIError(`Could not read ${flag} file ${filePath}: ${detail}`);
  }
}

// ── Group command default-help action ────────────────────────────────

/**
 * Configure a group command (parent of subcommands, no leaf action of its own)
 * to print help and exit 0 when invoked without a subcommand. Commander's
 * default behavior is to print help and exit 1, which is unfriendly for users
 * who type a parent like `robotnet me` expecting to discover its subcommands.
 */
export function defaultHelpOnBare(cmd: Command): Command {
  cmd.action(() => {
    cmd.help();
  });
  return cmd;
}
