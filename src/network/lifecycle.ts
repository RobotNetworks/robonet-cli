import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { CLIConfig } from "../config.js";
import { openProcessCredentialStore } from "../credentials/lifecycle.js";
import { CLI_VERSION } from "../version.js";
import {
  NetworkAlreadyRunningError,
  NetworkNotRunningError,
  NetworkPortOccupiedError,
  NetworkStartTimeoutError,
} from "./errors.js";
import { waitForHealth, type HealthSnapshot } from "./health.js";
import { assertLocalNetwork, networkPort } from "./local-network.js";
import { networkPaths } from "./paths.js";
import { isPortInUse, isProcessAlive, sendSignal, waitForExit } from "./process.js";
import {
  STATE_FILE_VERSION,
  deleteNetworkState,
  readNetworkState,
  writeNetworkState,
  type NetworkState,
} from "./state.js";
import { operatorConfigToEnv } from "../operator/config.js";

/** Default forked-child entrypoint: `bin/robotnet-operator.js`, which loads `dist/operator/index.js`. Resolved from this module's URL so the path works whether the CLI is running from a build, from a test harness, or from npm. */
function defaultOperatorEntrypoint(): string {
  // From `dist/network/lifecycle.js` → `../../bin/robotnet-operator.js`.
  // The `src/network/lifecycle.ts` source file resolves the same way at
  // runtime when loaded via tsx, so we don't need a dev/prod branch.
  return fileURLToPath(new URL("../../bin/robotnet-operator.js", import.meta.url));
}

/** Optional knobs the CLI doesn't expose today but tests do. */
export interface StartOptions {
  /** Override the forked-child entrypoint. Defaults to the bundled `bin/robotnet-operator.js`. */
  readonly operatorEntrypoint?: string;
  /** Override the ms-budget the supervisor waits for `/healthz` to come up. */
  readonly readinessTimeoutMs?: number;
  /** Override the node binary. Defaults to `process.execPath`. */
  readonly nodeBin?: string;
  /** Extra `node` flags to inject before the entrypoint (e.g. `--import tsx` in tests). */
  readonly nodeArgs?: readonly string[];
}

/** Result of a successful `start` — what the CLI prints to the user. */
export interface StartResult {
  readonly state: NetworkState;
  readonly health: HealthSnapshot;
  /** True iff the operator was already running and we adopted it instead of spawning a new one. */
  readonly adopted: boolean;
}

/** Result of `status` — null when nothing is running. */
export interface StatusResult {
  readonly state: NetworkState;
  /** Set when `/healthz` responded; absent when probe failed. */
  readonly health: HealthSnapshot | null;
}

/**
 * Start the local operator for `config.network`. Returns the running state
 * + initial health snapshot.
 *
 * Pre-conditions: the network must be a local one (loopback + agent-token);
 * see {@link assertLocalNetwork}. The CLI is responsible for the up-front
 * gate so end-users get a clear error from the command layer rather than a
 * cryptic one here.
 *
 * Side effects:
 *
 * - Spawns a detached `node` child running the operator entrypoint.
 * - Writes the network state file (`network.json`).
 * - Persists a freshly-minted local admin token in the encrypted credential store.
 *
 * If a stale state file points at a dead PID the supervisor cleans it up
 * and proceeds. If a healthy operator is already running, `start` returns
 * `adopted: true` instead of failing — `network start` should be safely
 * idempotent for users who lose track of whether they started it.
 */
export async function startNetwork(
  config: CLIConfig,
  opts: StartOptions = {},
): Promise<StartResult> {
  assertLocalNetwork(config.network);
  const networkName = config.network.name;
  const port = networkPort(config.network);
  const host = new URL(config.network.url).hostname.toLowerCase();
  const paths = networkPaths(config, networkName);

  // Adopt an existing healthy operator instead of failing — this is the
  // ergonomic story for users who type `network start` after a previous
  // session left one running.
  const existing = readNetworkState(paths.stateFile);
  if (existing !== null) {
    if (isProcessAlive(existing.pid)) {
      const url = `http://${existing.host}:${existing.port}/healthz`;
      try {
        const health = await waitForHealth(url, {
          deadlineMs: Date.now() + 1_500,
        });
        return { state: existing, health, adopted: true };
      } catch {
        // Process exists but isn't serving — could be initialising, but
        // we don't have a way to distinguish that from a wedged state, so
        // refuse to spawn a second one and surface the conflict.
        throw new NetworkAlreadyRunningError(networkName, existing.pid);
      }
    }
    // Stale state file with a dead PID — clean up and proceed.
    deleteNetworkState(paths.stateFile);
  }

  // The state file is now either absent or just-cleaned-up. If something
  // else is still holding the port (typically an orphan operator from a
  // previous run whose state file got wiped while the process kept
  // running), spawning a fresh child would hit EADDRINUSE inside the
  // forked process and the parent would only see a "did not become
  // healthy within Nms" timeout. Probe up front so the user gets an
  // actionable error pointing at the orphan.
  if (await isPortInUse(host, port)) {
    throw new NetworkPortOccupiedError(networkName, host, port);
  }

  const adminToken = mintAdminToken();
  const adminTokenHash = sha256Hex(adminToken);

  mkdirSync(dirname(paths.logFile), { recursive: true });
  mkdirSync(dirname(paths.databaseFile), { recursive: true });
  mkdirSync(paths.filesDir, { recursive: true });
  // Append-mode FD: keeps the log file mode 0600 + survives operator restarts.
  // Closed on the parent side after spawn — the child inherits a duped FD.
  const logFd = openSync(paths.logFile, "a", 0o600);
  let child: ChildProcess;
  try {
    const env = {
      ...process.env,
      ...operatorConfigToEnv({
        networkName,
        host,
        port,
        databasePath: paths.databaseFile,
        filesDir: paths.filesDir,
        adminTokenHash,
        operatorVersion: CLI_VERSION,
      }),
    };
    const nodeBin = opts.nodeBin ?? process.execPath;
    const entrypoint = opts.operatorEntrypoint ?? defaultOperatorEntrypoint();
    const args = [...(opts.nodeArgs ?? []), entrypoint];
    child = spawn(nodeBin, args, {
      env,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
  } finally {
    closeSync(logFd);
  }

  // `pid` is undefined when spawn fails synchronously (e.g. ENOENT on the
  // node binary). Surface as a startup failure with the log path so the
  // user has somewhere to look.
  const childPid = child.pid;
  if (childPid === undefined) {
    throw new NetworkStartTimeoutError(networkName, 0, paths.logFile);
  }
  // Detach so the CLI can exit while the operator keeps running. `unref` is
  // the documented way to allow the parent's event loop to drain past the
  // child reference.
  child.unref();

  const readinessTimeoutMs = opts.readinessTimeoutMs ?? 5_000;
  const deadline = Date.now() + readinessTimeoutMs;
  let health: HealthSnapshot;
  try {
    health = await waitForHealth(`http://${host}:${port}/healthz`, { deadlineMs: deadline });
  } catch {
    // Spawn looked OK but the listener never came up. Best effort: kill
    // the child so we don't leak a process the user can't see.
    sendSignal(childPid, "SIGTERM");
    throw new NetworkStartTimeoutError(
      networkName,
      readinessTimeoutMs,
      paths.logFile,
    );
  }

  const state: NetworkState = {
    schema_version: STATE_FILE_VERSION,
    network_name: networkName,
    host,
    port,
    pid: childPid,
    started_at_ms: Date.now(),
    operator_version: CLI_VERSION,
    log_file: paths.logFile,
    database_file: paths.databaseFile,
  };
  writeNetworkState(paths.stateFile, state);

  const store = await openProcessCredentialStore(config);
  store.putLocalAdminToken(networkName, adminToken);

  return { state, health, adopted: false };
}

/**
 * Stop the local operator for `config.network`.
 *
 * Sends SIGTERM, waits up to `gracefulTimeoutMs` for the process to exit,
 * escalates to SIGKILL if it doesn't. Always cleans up the state file so a
 * subsequent `start` doesn't trip the "already running" branch.
 */
export async function stopNetwork(
  config: CLIConfig,
  opts: { readonly gracefulTimeoutMs?: number } = {},
): Promise<{ readonly stoppedPid: number; readonly killed: boolean }> {
  assertLocalNetwork(config.network);
  const paths = networkPaths(config, config.network.name);
  const state = readNetworkState(paths.stateFile);
  if (state === null) throw new NetworkNotRunningError(config.network.name);

  if (!isProcessAlive(state.pid)) {
    deleteNetworkState(paths.stateFile);
    throw new NetworkNotRunningError(config.network.name);
  }

  const gracefulTimeoutMs = opts.gracefulTimeoutMs ?? 5_000;
  sendSignal(state.pid, "SIGTERM");
  const exited = await waitForExit(state.pid, {
    deadlineMs: Date.now() + gracefulTimeoutMs,
  });

  let killed = false;
  if (!exited) {
    sendSignal(state.pid, "SIGKILL");
    killed = true;
    // Wait briefly for the OS to reap the process before we report success.
    await waitForExit(state.pid, { deadlineMs: Date.now() + 1_000 });
  }

  deleteNetworkState(paths.stateFile);
  return { stoppedPid: state.pid, killed };
}

/** Inspect the running operator. Returns null when none is running; cleans up stale state files when found. */
export async function statusNetwork(config: CLIConfig): Promise<StatusResult | null> {
  assertLocalNetwork(config.network);
  const paths = networkPaths(config, config.network.name);
  const state = readNetworkState(paths.stateFile);
  if (state === null) return null;

  if (!isProcessAlive(state.pid)) {
    deleteNetworkState(paths.stateFile);
    return null;
  }

  let health: HealthSnapshot | null = null;
  try {
    const url = `http://${state.host}:${state.port}/healthz`;
    health = await waitForHealth(url, { deadlineMs: Date.now() + 1_000 });
  } catch {
    health = null;
  }
  return { state, health };
}

function mintAdminToken(): string {
  // 32 bytes of randomness → 43 char base64url. Plenty of entropy and
  // copy-pasteable as a single shell argument if anyone ever needs to.
  return randomBytes(32).toString("base64url");
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf-8").digest("hex");
}
