import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { RobotNetCLIError } from "../errors.js";
import { assertValidHandle } from "./handles.js";

/**
 * Directory-bound default agent identities, shared with the `asp` CLI.
 *
 * File path: `<dir>/.robotnet/asp.json`
 *
 * Shape:
 * ```
 * {
 *   "version": 1,
 *   "default_network": "local",
 *   "identities": {
 *     "local":  "@me.dev",
 *     "public": "@me.prod"
 *   }
 * }
 * ```
 *
 * Identities are network-keyed: a directory may bind a different handle
 * per network it interacts with. `default_network` is consumed by the
 * network-resolution chain (see `resolveDirectoryDefaultNetwork`) so a
 * directory that only ever talks to one network can be addressed without
 * `--network` on every command. The `version` field is reserved for
 * future format evolution; only `1` is accepted today.
 *
 * Both the `asp` and `robotnet` CLIs read and write this file shape; the
 * convention is workspace-wide, not a code dependency.
 */

const IDENTITY_DIR = ".robotnet";
const IDENTITY_FILE = "asp.json";
const FORMAT_VERSION = 1;

/** In-memory shape of a parsed directory identity file. */
export interface DirectoryIdentityFile {
  /** Network → handle map. May be empty when only `defaultNetwork` is set. */
  readonly identities: Readonly<Record<string, string>>;
  /** Optional default network for the directory; consumed by the network-resolution chain. */
  readonly defaultNetwork: string | undefined;
}

/** A {@link DirectoryIdentityFile} together with the absolute path it was loaded from. */
export interface ResolvedDirectoryIdentityFile extends DirectoryIdentityFile {
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
 * for the first `.robotnet/asp.json` with valid contents. Returns `undefined`
 * when no file is found before reaching the filesystem root.
 */
export async function findDirectoryIdentityFile(
  fromDir?: string,
): Promise<ResolvedDirectoryIdentityFile | undefined> {
  let dir = fromDir ?? process.cwd();
  for (;;) {
    const candidate = directoryIdentityPath(dir);
    const file = await tryReadIdentityFile(candidate);
    if (file !== undefined) {
      return { ...file, filePath: candidate };
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Look up the handle bound to a specific network in a parsed file, if any. */
export function lookupDirectoryHandle(
  file: DirectoryIdentityFile,
  network: string,
): string | undefined {
  return file.identities[network];
}

/**
 * Add or overwrite a single `(network, handle)` entry in `<dir>/.robotnet/asp.json`,
 * preserving any other entries already present. Creates the file (and the
 * `.robotnet/` directory) if missing. When the file is being created — or has
 * no `default_network` set — the new network is also seeded as the default
 * so a subsequent `robotnet listen` from the same directory targets it
 * without needing an extra flag.
 *
 * Returns the absolute file path.
 */
export async function writeDirectoryIdentityEntry(
  dir: string,
  args: { readonly handle: string; readonly network: string },
): Promise<string> {
  assertValidHandle(args.handle);
  const filePath = directoryIdentityPath(dir);
  const existing = await tryReadIdentityFile(filePath);

  const identities: Record<string, string> = {
    ...(existing?.identities ?? {}),
    [args.network]: args.handle,
  };
  const defaultNetwork = existing?.defaultNetwork ?? args.network;

  await writeIdentityFile(filePath, { identities, defaultNetwork });
  return filePath;
}

/**
 * Remove `<dir>/.robotnet/asp.json` entirely. Returns `true` if removed,
 * `false` if the file did not exist.
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
 *   1. `--as <handle>` flag                                                   → `source: "flag"`
 *   2. `ROBOTNET_AGENT` env var                                               → `source: "env"`
 *   3. The directory file's `identities` map looked up by `resolvedNetwork`   → `source: "directory"`
 *
 * Returns `undefined` when no source supplied a handle for the resolved
 * network — callers should surface a friendly "specify --as or run
 * `robotnet identity set`" message.
 *
 * Pass the network the command already resolved via the network-precedence
 * chain (typically `config.network.name`). The directory lookup is scoped
 * to that network: a directory bound to `@me.dev` on `local` does not
 * contribute when the command is targeting `public`.
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

  const envHandle = process.env["ROBOTNET_AGENT"];
  if (envHandle !== undefined && envHandle.length > 0) {
    assertValidHandle(envHandle);
    return {
      handle: envHandle,
      network: args.resolvedNetwork,
      source: "env",
    };
  }

  const file = await findDirectoryIdentityFile(args.fromDir);
  if (file !== undefined) {
    const handle = lookupDirectoryHandle(file, args.resolvedNetwork);
    if (handle !== undefined) {
      return {
        handle,
        network: args.resolvedNetwork,
        source: "directory",
      };
    }
  }

  return undefined;
}

/**
 * Read just the directory file's `default_network` field by walking up from
 * `fromDir`. Used by the network-resolution chain so a directory binding
 * can contribute a default network when no flag, env var, or workspace
 * `config.json` pin is present. Returns `undefined` when no file is found
 * or the file has no `default_network`.
 */
export async function findDirectoryDefaultNetwork(
  fromDir?: string,
): Promise<string | undefined> {
  const file = await findDirectoryIdentityFile(fromDir);
  return file?.defaultNetwork;
}

async function tryReadIdentityFile(
  filePath: string,
): Promise<DirectoryIdentityFile | undefined> {
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
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new IdentityFileError(`${filePath} must contain a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;

  if (obj["version"] !== FORMAT_VERSION) {
    throw new IdentityFileError(
      `${filePath} has unsupported \`version\` ${JSON.stringify(obj["version"])} (expected ${FORMAT_VERSION})`,
    );
  }

  const rawIdentities = obj["identities"];
  if (
    typeof rawIdentities !== "object" ||
    rawIdentities === null ||
    Array.isArray(rawIdentities)
  ) {
    throw new IdentityFileError(
      `${filePath} requires an \`identities\` object mapping network → handle`,
    );
  }
  const identities: Record<string, string> = {};
  for (const [network, handle] of Object.entries(rawIdentities)) {
    if (typeof handle !== "string" || handle.length === 0) {
      throw new IdentityFileError(
        `${filePath} entry for network "${network}" must be a non-empty string handle`,
      );
    }
    identities[network] = handle;
  }

  const rawDefault = obj["default_network"];
  let defaultNetwork: string | undefined;
  if (rawDefault === undefined || rawDefault === null) {
    defaultNetwork = undefined;
  } else if (typeof rawDefault === "string" && rawDefault.length > 0) {
    defaultNetwork = rawDefault;
  } else {
    throw new IdentityFileError(
      `${filePath} \`default_network\` must be a non-empty string when present`,
    );
  }

  return { identities, defaultNetwork };
}

async function writeIdentityFile(
  filePath: string,
  file: DirectoryIdentityFile,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const payload: Record<string, unknown> = {
    version: FORMAT_VERSION,
    identities: file.identities,
  };
  if (file.defaultNetwork !== undefined) {
    payload["default_network"] = file.defaultNetwork;
  }
  await writeFile(filePath, JSON.stringify(payload, null, 2) + "\n", "utf8");
}
