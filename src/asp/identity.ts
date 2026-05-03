import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { RobotNetCLIError } from "../errors.js";
import { assertValidHandle } from "./handles.js";

/**
 * Directory-bound default agent identity, shared with the `asp` CLI.
 *
 * Format:  `<dir>/.robotnet/asp.json`
 *          `{ "version": 1, "handle": "@cli.bot", "network": "default" }`
 *
 * Both `asp identity set` and `robotnet identity set` write this file, and both
 * CLIs read it to pick up "the agent for this directory" without `--as` on
 * every command. Keeping the shape stable is a workspace-wide convention, not
 * coupling — neither CLI imports the other.
 */

const IDENTITY_DIR = ".robotnet";
const IDENTITY_FILE = "asp.json";

export interface DirectoryIdentity {
  readonly handle: string;
  readonly network: string;
}

export interface ResolvedDirectoryIdentity extends DirectoryIdentity {
  /** Absolute path of the `.robotnet/asp.json` file the identity was loaded from. */
  readonly filePath: string;
}

/** Where the resolved agent handle came from, surfaced for diagnostics. */
export type AgentIdentitySource = "flag" | "env" | "directory";

export interface ResolvedAgentIdentity {
  readonly handle: string;
  readonly network: string;
  readonly source: AgentIdentitySource;
}

export class IdentityFileError extends RobotNetCLIError {
  constructor(message: string) {
    super(message);
    this.name = "IdentityFileError";
  }
}

/** Build the absolute path to `<dir>/.robotnet/asp.json` without checking existence. */
export function directoryIdentityPath(dir: string): string {
  return join(dir, IDENTITY_DIR, IDENTITY_FILE);
}

/**
 * Walk up the directory tree from `fromDir` (default `process.cwd()`) looking
 * for the first `.robotnet/asp.json` with a valid identity. Returns
 * `undefined` if none is found by the filesystem root.
 */
export async function findDirectoryIdentity(
  fromDir?: string,
): Promise<ResolvedDirectoryIdentity | undefined> {
  let dir = fromDir ?? process.cwd();
  for (;;) {
    const candidate = directoryIdentityPath(dir);
    const config = await tryReadIdentity(candidate);
    if (config !== undefined) {
      return { ...config, filePath: candidate };
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Write `.robotnet/asp.json` in `dir`, creating the `.robotnet/` directory if needed. */
export async function writeDirectoryIdentity(
  dir: string,
  identity: DirectoryIdentity,
): Promise<string> {
  assertValidHandle(identity.handle);
  const configDir = join(dir, IDENTITY_DIR);
  await mkdir(configDir, { recursive: true });
  const filePath = join(configDir, IDENTITY_FILE);
  const payload = {
    version: 1,
    handle: identity.handle,
    network: identity.network,
  };
  await writeFile(filePath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  return filePath;
}

/**
 * Remove `.robotnet/asp.json` from `dir`. Returns `true` if removed, `false`
 * if the file did not exist.
 */
export async function clearDirectoryIdentity(dir: string): Promise<boolean> {
  const filePath = directoryIdentityPath(dir);
  try {
    await unlink(filePath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Resolve which agent a command should act as.
 *
 * Precedence:
 *   1. `--as <handle>` flag                   → `source: "flag"`
 *   2. `ROBOTNET_AGENT` env var               → `source: "env"`
 *   3. `.robotnet/asp.json` directory file    → `source: "directory"`
 *
 * Returns `undefined` when no source supplied a handle — callers should
 * surface a friendly "specify --as or run `robotnet identity set`" message.
 *
 * Network resolution is independent: pass the network the command already
 * resolved (typically `config.network.name`). When the directory identity
 * names a different network, that fact is returned alongside the handle so
 * callers can decide whether to honor it or warn.
 */
export async function resolveAgentIdentity(args: {
  readonly explicitHandle?: string;
  readonly resolvedNetwork: string;
  readonly fromDir?: string;
}): Promise<ResolvedAgentIdentity | undefined> {
  if (args.explicitHandle !== undefined && args.explicitHandle.length > 0) {
    assertValidHandle(args.explicitHandle);
    return {
      handle: args.explicitHandle,
      network: args.resolvedNetwork,
      source: "flag",
    };
  }

  const directory = await findDirectoryIdentity(args.fromDir);

  const envHandle = process.env["ROBOTNET_AGENT"];
  if (envHandle !== undefined && envHandle.length > 0) {
    assertValidHandle(envHandle);
    return {
      handle: envHandle,
      network: directory?.network ?? args.resolvedNetwork,
      source: "env",
    };
  }

  if (directory !== undefined) {
    return {
      handle: directory.handle,
      network: directory.network,
      source: "directory",
    };
  }

  return undefined;
}

async function tryReadIdentity(
  filePath: string,
): Promise<DirectoryIdentity | undefined> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new IdentityFileError(
      `${filePath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!isDirectoryIdentity(parsed)) {
    throw new IdentityFileError(
      `${filePath} is missing required fields (\`handle\` and \`network\`)`,
    );
  }
  return parsed;
}

function isDirectoryIdentity(v: unknown): v is DirectoryIdentity {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as Record<string, unknown>)["handle"] === "string" &&
    typeof (v as Record<string, unknown>)["network"] === "string"
  );
}
