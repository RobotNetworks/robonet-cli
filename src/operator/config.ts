/**
 * Configuration for the spawned operator child process.
 *
 * The CLI side (`src/network/lifecycle.ts`) builds this in-process, encodes it
 * as environment variables, and the child reads it back here on startup. We
 * use env vars instead of CLI args so that secrets (the admin token hash) and
 * paths don't appear in `ps` output.
 */

const ENV_PREFIX = "ROBOTNET_OPERATOR_";

/** Variables the operator child reads from `process.env` on startup. */
export interface OperatorConfig {
  readonly networkName: string;
  /** Loopback host the HTTP server binds to. Always `127.0.0.1` in v1. */
  readonly host: string;
  /** Port to bind. */
  readonly port: number;
  /** Absolute path to the operator's SQLite database. Created on first start. */
  readonly databasePath: string;
  /**
   * sha256 hex digest of the admin bearer token. The plaintext lives only in
   * the CLI's encrypted credential store; the operator stores the hash and
   * compares hashes on every admin request so the plaintext never lands on
   * disk in a long-lived file.
   */
  readonly adminTokenHash: string;
  /** Operator binary version, surfaced in `network status` and `/healthz`. */
  readonly operatorVersion: string;
}

export class OperatorConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperatorConfigError";
  }
}

function readVar(key: string): string {
  const v = process.env[`${ENV_PREFIX}${key}`];
  if (v === undefined || v.length === 0) {
    throw new OperatorConfigError(
      `${ENV_PREFIX}${key} is required but missing or empty.`,
    );
  }
  return v;
}

function readPort(): number {
  const raw = readVar("PORT");
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535 || String(n) !== raw) {
    throw new OperatorConfigError(
      `${ENV_PREFIX}PORT must be a valid TCP port (1-65535), got ${JSON.stringify(raw)}.`,
    );
  }
  return n;
}

function readHash(key: string): string {
  const v = readVar(key);
  if (!/^[0-9a-f]{64}$/.test(v)) {
    throw new OperatorConfigError(
      `${ENV_PREFIX}${key} must be a 64-character lowercase hex sha256 digest.`,
    );
  }
  return v;
}

/** Read & validate all operator config from `process.env`. Throws {@link OperatorConfigError} on any malformed input. */
export function operatorConfigFromEnv(): OperatorConfig {
  return {
    networkName: readVar("NETWORK_NAME"),
    host: readVar("HOST"),
    port: readPort(),
    databasePath: readVar("DATABASE_PATH"),
    adminTokenHash: readHash("ADMIN_TOKEN_HASH"),
    operatorVersion: readVar("VERSION"),
  };
}

/** Build the env-var bag the CLI passes to `child_process.fork`. */
export function operatorConfigToEnv(config: OperatorConfig): NodeJS.ProcessEnv {
  return {
    [`${ENV_PREFIX}NETWORK_NAME`]: config.networkName,
    [`${ENV_PREFIX}HOST`]: config.host,
    [`${ENV_PREFIX}PORT`]: String(config.port),
    [`${ENV_PREFIX}DATABASE_PATH`]: config.databasePath,
    [`${ENV_PREFIX}ADMIN_TOKEN_HASH`]: config.adminTokenHash,
    [`${ENV_PREFIX}VERSION`]: config.operatorVersion,
  };
}
