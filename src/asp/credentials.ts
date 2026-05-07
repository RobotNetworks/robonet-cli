import { join } from "node:path";

import { RobotNetCLIError } from "../errors.js";

/**
 * Filesystem layout for legacy file-based credential storage.
 *
 * Newly-issued credentials are stored in the SQLite credential store
 * (`src/credentials/store.ts`); these paths exist only so the migration
 * pass can find and ingest credentials written by older versions of the
 * CLI. Once everyone has upgraded past the migration window, this module
 * collapses further (the path computation is the only thing the migration
 * needs from here).
 */

const NETWORK_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export class InvalidNetworkNameError extends RobotNetCLIError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidNetworkNameError";
  }
}

export class CredentialNotFoundError extends RobotNetCLIError {
  readonly handle: string;
  readonly networkName: string;
  constructor(handle: string, networkName: string) {
    super(
      `no stored token for ${handle} on network "${networkName}". ` +
        `Run \`robotnet login --agent ${handle} --network ${networkName}\` (remote) ` +
        `or \`robotnet agent create ${handle} --network ${networkName}\` (local) first, ` +
        `or pass --token.`,
    );
    this.name = "CredentialNotFoundError";
    this.handle = handle;
    this.networkName = networkName;
  }
}

export class LocalAdminTokenNotFoundError extends RobotNetCLIError {
  readonly networkName: string;
  constructor(networkName: string) {
    super(
      `no local admin token for network "${networkName}". ` +
        `Start the operator with \`robotnet network start --network ${networkName}\`, ` +
        `or pass --local-admin-token.`,
    );
    this.name = "LocalAdminTokenNotFoundError";
    this.networkName = networkName;
  }
}

export interface NetworkStatePaths {
  readonly networkDir: string;
  readonly adminTokenFile: string;
  readonly credentialsDir: string;
  readonly networkInfoFile: string;
  readonly pidFile: string;
  readonly sqliteFile: string;
  readonly logDir: string;
  readonly serverLogFile: string;
}

export function assertValidNetworkName(name: string): void {
  if (!NETWORK_NAME_PATTERN.test(name)) {
    throw new InvalidNetworkNameError(
      `invalid network name "${name}" (lowercase letters, digits, underscore, ` +
        `hyphen only; must start with a letter or digit; max 64 chars)`,
    );
  }
}

/**
 * Compute the on-disk paths for a single network's legacy file-based state.
 * Does not touch the filesystem.
 *
 * Used by the migration sweep to find admin/agent token files written by
 * older CLI versions, and re-used as a stable layout description in case
 * future tooling (e.g. desktop app supervisor logs) needs the same paths.
 */
export function networkStatePaths(
  profileStateDir: string,
  networkName: string,
): NetworkStatePaths {
  assertValidNetworkName(networkName);
  const networkDir = join(profileStateDir, "networks", networkName);
  const logDir = join(networkDir, "logs");
  return {
    networkDir,
    adminTokenFile: join(networkDir, "admin.token"),
    credentialsDir: join(networkDir, "credentials"),
    networkInfoFile: join(networkDir, "network.json"),
    pidFile: join(networkDir, "asp.pid"),
    sqliteFile: join(networkDir, "asp.sqlite"),
    logDir,
    serverLogFile: join(logDir, "server.log"),
  };
}
