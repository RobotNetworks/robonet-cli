import * as fs from "node:fs";
import * as path from "node:path";
import * as child_process from "node:child_process";
import { fileURLToPath } from "node:url";
import type { CLIConfig } from "../config.js";
import type { DaemonState } from "./state.js";
import { epochMillis, loadDaemonState, saveDaemonState } from "./state.js";
import { DaemonError } from "../errors.js";

const STATE_FILE_NAME = "daemon.json";
const PID_FILE_NAME = "robonet.pid";
const MAX_LOG_BYTES = 5 * 1_048_576; // 5 MB
const LOG_FILE_NAME = "listener.log";

export interface DaemonPaths {
  readonly stateFile: string;
  readonly pidFile: string;
  readonly logFile: string;
}

export function resolveDaemonPaths(config: CLIConfig): DaemonPaths {
  return {
    stateFile: path.join(config.paths.runDir, STATE_FILE_NAME),
    pidFile: path.join(config.paths.runDir, PID_FILE_NAME),
    logFile: path.join(config.paths.logsDir, LOG_FILE_NAME),
  };
}

function markStopped(state: DaemonState, stateFile: string): DaemonState {
  const stopped: DaemonState = {
    ...state,
    pid: null,
    health: "stopped",
    updatedAt: epochMillis(),
  };
  saveDaemonState(stateFile, stopped);
  return stopped;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") return true;
    return false;
  }
}

export function startDaemon(options: {
  config: CLIConfig;
  clientId: string | null;
  clientSecret: string | null;
  scope: string;
}): { pid: number; paths: DaemonPaths } {
  const { config, clientId, clientSecret, scope } = options;
  const paths = resolveDaemonPaths(config);

  const existingState = loadDaemonState(paths.stateFile);
  if (existingState?.pid && isProcessAlive(existingState.pid)) {
    throw new DaemonError(`Daemon already running with pid ${existingState.pid}.`);
  }

  fs.mkdirSync(path.dirname(paths.stateFile), { recursive: true });
  fs.mkdirSync(path.dirname(paths.logFile), { recursive: true });
  fs.writeFileSync(paths.logFile, "", "utf-8");

  const initialState: DaemonState = {
    pid: null,
    health: "starting",
    websocketUrl: config.endpoints.websocketUrl,
    clientId: clientId ?? "",
    agentRef: null,
    lastEventAt: null,
    lastError: null,
    updatedAt: epochMillis(),
    logFile: paths.logFile,
  };
  saveDaemonState(paths.stateFile, initialState);

  rotateLogIfNeeded(paths.logFile);
  const logFd = fs.openSync(paths.logFile, "a");

  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const binPath = path.resolve(thisDir, "../../bin/robonet.js");
  const args = [
    binPath,
    "daemon",
    "run-listener",
    "--scope",
    scope,
    ...(clientId ? ["--client-id", clientId] : []),
  ];

  const env: Record<string, string | undefined> = {
    ...process.env,
    ROBONET_PROFILE: config.profile,
  };
  if (clientSecret) {
    env.ROBONET_CLIENT_SECRET = clientSecret;
  }

  const child = child_process.spawn(process.execPath, args, {
    cwd: process.cwd(),
    stdio: ["ignore", logFd, logFd],
    detached: true,
    windowsHide: true,
    env,
  });
  child.unref();
  fs.closeSync(logFd);

  const pid = child.pid;
  if (pid === undefined) {
    throw new DaemonError("Failed to spawn daemon process.");
  }
  fs.writeFileSync(paths.pidFile, `${pid}\n`, "utf-8");
  saveDaemonState(paths.stateFile, { ...initialState, pid, updatedAt: epochMillis() });

  return { pid, paths };
}

export function stopDaemon(options: {
  config: CLIConfig;
  waitTimeoutSeconds?: number;
}): DaemonState | null {
  const { config, waitTimeoutSeconds = 5 } = options;
  const paths = resolveDaemonPaths(config);
  const state = loadDaemonState(paths.stateFile);
  if (!state?.pid) return null;

  if (isProcessAlive(state.pid)) {
    if (process.platform === "win32") {
      // On Windows, process.kill() maps to TerminateProcess (always ungraceful).
      // No equivalent of SIGTERM exists, so just terminate immediately.
      process.kill(state.pid);
    } else {
      process.kill(state.pid, "SIGTERM");
      const deadline = Date.now() + waitTimeoutSeconds * 1000;
      const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
      while (Date.now() < deadline) {
        if (!isProcessAlive(state.pid)) break;
        Atomics.wait(sleepBuffer, 0, 0, 100);
      }
      if (isProcessAlive(state.pid)) {
        process.kill(state.pid, "SIGKILL");
      }
    }
  }

  const stoppedState = markStopped(state, paths.stateFile);
  if (fs.existsSync(paths.pidFile)) {
    fs.unlinkSync(paths.pidFile);
  }
  return stoppedState;
}

export function restartDaemon(options: {
  config: CLIConfig;
  clientId: string | null;
  clientSecret: string | null;
  scope: string;
}): { pid: number; paths: DaemonPaths } {
  stopDaemon({ config: options.config });
  return startDaemon(options);
}

export function loadStatus(config: CLIConfig): DaemonState | null {
  const paths = resolveDaemonPaths(config);
  const state = loadDaemonState(paths.stateFile);
  if (!state) return null;
  if (state.pid === null) return state;
  if (isProcessAlive(state.pid)) return state;

  return markStopped(state, paths.stateFile);
}

function rotateLogIfNeeded(logFile: string): void {
  try {
    const stat = fs.statSync(logFile);
    if (stat.size > MAX_LOG_BYTES) {
      const rotated = `${logFile}.1`;
      fs.renameSync(logFile, rotated);
    }
  } catch {
    // File doesn't exist yet or can't stat -- nothing to rotate
  }
}

export function readLogTail(logFile: string, lines: number = 50): string[] {
  let fd: number;
  try {
    fd = fs.openSync(logFile, "r");
  } catch {
    return [];
  }

  try {
    const stat = fs.fstatSync(fd);
    if (stat.size === 0) return [];

    // Read up to 64KB from the end of the file -- enough for typical log lines
    const chunkSize = Math.min(stat.size, 64 * 1024);
    const buffer = Buffer.alloc(chunkSize);
    fs.readSync(fd, buffer, 0, chunkSize, stat.size - chunkSize);
    const text = buffer.toString("utf-8");

    const allLines = text.split("\n");
    // Remove trailing empty element from split
    if (allLines.length > 0 && allLines[allLines.length - 1] === "") {
      allLines.pop();
    }
    // If we read a partial file, the first line may be truncated -- drop it
    if (chunkSize < stat.size && allLines.length > 0) {
      allLines.shift();
    }
    return allLines.slice(-lines);
  } finally {
    fs.closeSync(fd);
  }
}
