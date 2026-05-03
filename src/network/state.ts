import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import { CorruptNetworkStateError } from "./errors.js";

/**
 * Versioned on-disk state for a running local operator.
 *
 * Lives at {@link NetworkPaths.stateFile}. Written atomically by the
 * supervisor on `network start`; deleted on a clean stop. A stale state
 * file with a dead PID is treated as "not running" and is cleaned up
 * lazily by `status` / `start`.
 *
 * The schema is versioned for forward-compat; bumping `STATE_FILE_VERSION`
 * lets us evolve the file shape while still reading older files.
 */
export interface NetworkState {
  readonly schema_version: number;
  readonly network_name: string;
  readonly host: string;
  readonly port: number;
  readonly pid: number;
  readonly started_at_ms: number;
  readonly operator_version: string;
  readonly log_file: string;
  readonly database_file: string;
}

export const STATE_FILE_VERSION = 1;

export function writeNetworkState(filePath: string, state: NetworkState): void {
  mkdirSync(dirname(filePath), { recursive: true });
  // Write to a sibling temp file then rename so a crashed write never leaves
  // a half-written network.json that subsequent reads choke on. POSIX rename
  // is atomic so readers either see the old file or the fully-written new
  // one, never an in-progress write.
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, filePath);
}

/** Read the state file, or `null` when it does not exist. */
export function readNetworkState(filePath: string): NetworkState | null {
  if (!existsSync(filePath)) return null;
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new CorruptNetworkStateError(filePath, `read failed: ${detail}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new CorruptNetworkStateError(filePath, `not valid JSON: ${detail}`);
  }
  return parseNetworkState(filePath, parsed);
}

export function deleteNetworkState(filePath: string): void {
  rmSync(filePath, { force: true });
}

function parseNetworkState(filePath: string, raw: unknown): NetworkState {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new CorruptNetworkStateError(filePath, "expected a JSON object");
  }
  const o = raw as Record<string, unknown>;
  const reqString = (key: string): string => {
    const v = o[key];
    if (typeof v !== "string" || v.length === 0) {
      throw new CorruptNetworkStateError(filePath, `field "${key}" must be a non-empty string`);
    }
    return v;
  };
  const reqInt = (key: string): number => {
    const v = o[key];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
      throw new CorruptNetworkStateError(
        filePath,
        `field "${key}" must be a non-negative integer`,
      );
    }
    return v;
  };
  const version = reqInt("schema_version");
  if (version > STATE_FILE_VERSION) {
    throw new CorruptNetworkStateError(
      filePath,
      `schema_version ${version} is newer than this CLI supports (${STATE_FILE_VERSION}). Upgrade the CLI.`,
    );
  }
  return {
    schema_version: version,
    network_name: reqString("network_name"),
    host: reqString("host"),
    port: reqInt("port"),
    pid: reqInt("pid"),
    started_at_ms: reqInt("started_at_ms"),
    operator_version: reqString("operator_version"),
    log_file: reqString("log_file"),
    database_file: reqString("database_file"),
  };
}

