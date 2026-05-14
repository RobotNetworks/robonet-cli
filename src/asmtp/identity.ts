import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { RobotNetCLIError } from "../errors.js";
import { assertValidHandle } from "./handles.js";

/**
 * Directory-bound default agent identity, stored alongside the other
 * workspace pins (`network`, `profile`) inside a single
 * `<dir>/.robotnet/config.json`.
 *
 * Shape (every key optional; all coexist with the keys read by `loadConfig`):
 * ```
 * {
 *   "profile": "default",
 *   "network": "local",
 *   "agent":   "@me.dev"
 * }
 * ```
 *
 * The `agent` field is **scoped to the workspace's `network`**: it
 * contributes to the acting-agent resolution chain only when the resolved
 * network matches the workspace's `network` field. A workspace pinned to
 * `local` with agent `@me.dev` does **not** bind `@me.dev` on `public` —
 * commands targeting `public` from this directory must supply an agent
 * via `--as` or `ROBOTNET_AGENT`. This keeps the (network, agent) tuple
 * coherent: you cannot accidentally act as a handle that has no
 * credential on the target network.
 *
 * `robotnet identity set <handle>` writes `agent` and seeds `network`
 * (when absent), preserving any unrelated keys already in the file.
 */

const WORKSPACE_DIR = ".robotnet";
const WORKSPACE_FILE = "config.json";

/** In-memory shape of the identity-relevant slice of `<dir>/.robotnet/config.json`. */
export interface DirectoryIdentityFile {
  /** Agent handle bound by the workspace, if any. */
  readonly agent: string | undefined;
  /** Network the workspace is pinned to (the agent's binding network). */
  readonly network: string | undefined;
}

/** A {@link DirectoryIdentityFile} together with the absolute path it was loaded from. */
export interface ResolvedDirectoryIdentityFile extends DirectoryIdentityFile {
  readonly filePath: string;
}

/** Where the resolved agent handle came from, surfaced for diagnostics. */
export type AgentIdentitySource = "flag" | "env" | "directory";

export interface ResolvedAgentIdentity {
  readonly handle: string;
  readonly source: AgentIdentitySource;
  /**
   * For `source: "directory"`, the absolute path to the workspace file
   * that supplied the agent — used by error messages to name the source
   * concretely. Undefined for `flag` and `env`.
   */
  readonly sourceFile?: string;
}

export class IdentityFileError extends RobotNetCLIError {
  constructor(message: string) {
    super(message);
    this.name = "IdentityFileError";
  }
}

/** Build the absolute path to `<dir>/.robotnet/config.json` without checking existence. */
export function directoryIdentityPath(dir: string): string {
  return join(dir, WORKSPACE_DIR, WORKSPACE_FILE);
}

/**
 * Walk up the directory tree from `fromDir` (default `process.cwd()`) looking
 * for the first `.robotnet/config.json` with valid contents. Returns
 * `undefined` when no file is found before reaching the filesystem root.
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

/**
 * Add or overwrite the workspace's `agent` field in
 * `<dir>/.robotnet/config.json`, preserving every other top-level key in
 * the file (`profile`, etc.). Creates the file (and the `.robotnet/`
 * directory) if missing.
 *
 * Network-pin policy:
 *   - `pinNetwork="seed"` (default): only write the `network` field
 *     when it's absent or empty in the existing file. Preserves a
 *     prior pin when the caller didn't intend to change networks.
 *   - `pinNetwork="overwrite"`: replace the `network` field with
 *     `args.network` unconditionally. Use when the user explicitly
 *     selected the network (e.g. `--network` flag or `ROBOTNET_NETWORK`
 *     env) — otherwise the agent ends up bound to one network while
 *     the workspace stays pinned to another, and subsequent commands
 *     refuse with "no agent specified for network X".
 *
 * Returns the absolute path and the final persisted `network` value
 * so the caller can report exactly what was written.
 */
export interface WriteDirectoryIdentityResult {
  readonly filePath: string;
  readonly persistedNetwork: string;
}

export async function writeDirectoryIdentityEntry(
  dir: string,
  args: {
    readonly handle: string;
    readonly network: string;
    readonly pinNetwork?: "seed" | "overwrite";
  },
): Promise<WriteDirectoryIdentityResult> {
  assertValidHandle(args.handle);
  const filePath = directoryIdentityPath(dir);
  const existing = await readWorkspaceFileRaw(filePath);

  const next: Record<string, unknown> = { ...existing, agent: args.handle };
  const mode = args.pinNetwork ?? "seed";
  const networkPin = next["network"];
  const networkPinIsBlank =
    typeof networkPin !== "string" || networkPin.trim().length === 0;
  if (mode === "overwrite" || networkPinIsBlank) {
    next["network"] = args.network;
  }

  await writeWorkspaceFile(filePath, next);
  return { filePath, persistedNetwork: String(next["network"]) };
}

/**
 * Remove the `agent` field from `<dir>/.robotnet/config.json`, leaving any
 * other keys (`profile`, `network`) intact. If the file would be left with
 * no keys at all, the file is removed entirely. Returns `true` if anything
 * was modified or removed, `false` if the file did not exist or had no
 * `agent` field to clear.
 */
export async function clearDirectoryIdentity(dir: string): Promise<boolean> {
  const filePath = directoryIdentityPath(dir);
  const existing = await readWorkspaceFileRaw(filePath);
  if (!("agent" in existing)) return false;

  delete existing["agent"];

  if (Object.keys(existing).length === 0) {
    try {
      await unlink(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    return true;
  }

  await writeWorkspaceFile(filePath, existing);
  return true;
}

/**
 * Resolve which agent a command should act as.
 *
 * Precedence:
 *   1. `--as <handle>` flag                                        > `source: "flag"`
 *   2. `ROBOTNET_AGENT` env var                                    > `source: "env"`
 *   3. The workspace file's `agent` field, **only when the file's
 *      `network` field equals `resolvedNetwork`**                  > `source: "directory"`
 *
 * Returns `undefined` when no source supplied a handle for the resolved
 * network. Callers should surface a friendly "specify --as or run
 * `robotnet identity set`" message.
 *
 * Pass the network the command already resolved via the network-precedence
 * chain (typically `config.network.name`). The workspace contribution is
 * scoped to that network: a directory pinned to `local` with agent
 * `@me.dev` contributes nothing when the command is targeting `public`.
 */
export async function resolveAgentIdentity(args: {
  readonly explicitHandle?: string;
  readonly resolvedNetwork: string;
  readonly fromDir?: string;
}): Promise<ResolvedAgentIdentity | undefined> {
  if (args.explicitHandle !== undefined && args.explicitHandle.length > 0) {
    assertValidHandle(args.explicitHandle);
    return { handle: args.explicitHandle, source: "flag" };
  }

  const envHandle = process.env["ROBOTNET_AGENT"];
  if (envHandle !== undefined && envHandle.length > 0) {
    assertValidHandle(envHandle);
    return { handle: envHandle, source: "env" };
  }

  const file = await findDirectoryIdentityFile(args.fromDir);
  if (
    file !== undefined &&
    file.agent !== undefined &&
    file.network !== undefined &&
    file.network === args.resolvedNetwork
  ) {
    return { handle: file.agent, source: "directory", sourceFile: file.filePath };
  }

  return undefined;
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
  const parsed = parseWorkspaceJson(raw, filePath);
  return {
    agent: readOptionalStringField(parsed, "agent", filePath),
    network: readOptionalStringField(parsed, "network", filePath),
  };
}

async function readWorkspaceFileRaw(
  filePath: string,
): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return {};
  }
  return parseWorkspaceJson(raw, filePath);
}

function parseWorkspaceJson(raw: string, filePath: string): Record<string, unknown> {
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
  return parsed as Record<string, unknown>;
}

function readOptionalStringField(
  parsed: Record<string, unknown>,
  field: string,
  filePath: string,
): string | undefined {
  const raw = parsed[field];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    throw new IdentityFileError(
      `${filePath} \`${field}\` must be a string when present`,
    );
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function writeWorkspaceFile(
  filePath: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(payload, null, 2) + "\n", "utf8");
}
