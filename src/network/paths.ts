import * as path from "node:path";

import type { CLIConfig } from "../config.js";

/**
 * Per-network on-disk layout.
 *
 * Three concerns are split deliberately:
 *
 * - `runDir`: ephemeral runtime state (PID, port). Wiped on stop.
 * - `logsDir`: tailable text logs. Survives across runs but is rotatable.
 * - `stateDir`: persistent operator data (the SQLite DB). Survives across
 *   runs and across CLI upgrades.
 *
 * Splitting them keeps `network reset` honest: deleting the persistent DB
 * doesn't take logs with it, and a crashed PID file doesn't pin the DB
 * down.
 */
export interface NetworkPaths {
  readonly stateFile: string;
  readonly logFile: string;
  readonly databaseFile: string;
}

export function networkPaths(config: CLIConfig, networkName: string): NetworkPaths {
  return {
    stateFile: path.join(config.paths.runDir, "networks", networkName, "network.json"),
    logFile: path.join(config.paths.logsDir, "networks", networkName, "operator.log"),
    databaseFile: path.join(
      config.paths.stateDir,
      "networks",
      networkName,
      "operator.sqlite",
    ),
  };
}
