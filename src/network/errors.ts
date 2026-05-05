import { RobotNetCLIError } from "../errors.js";

/** Operation not allowed against the configured network (e.g. supervising a remote one). */
export class NotALocalNetworkError extends RobotNetCLIError {
  constructor(networkName: string, reason: string) {
    super(
      `Network "${networkName}" is not a local network: ${reason}. ` +
        `\`robotnet network <subcommand>\` only works on local networks. ` +
        `For a remote network use \`robotnet --network ${networkName} login\`.`,
    );
    this.name = "NotALocalNetworkError";
  }
}

/** Returned from `stop` / `status` when no operator is running for the network. */
export class NetworkNotRunningError extends RobotNetCLIError {
  constructor(networkName: string) {
    super(`No local operator is running for network "${networkName}".`);
    this.name = "NetworkNotRunningError";
  }
}

/** Returned from `start` when an operator is already running for the network. */
export class NetworkAlreadyRunningError extends RobotNetCLIError {
  constructor(networkName: string, pid: number) {
    super(
      `A local operator for network "${networkName}" is already running (pid ${pid}). ` +
        `Run \`robotnet network status\` to inspect, or \`robotnet network stop\` first.`,
    );
    this.name = "NetworkAlreadyRunningError";
  }
}

/** The operator process exited or failed to become healthy within the start-up budget. */
export class NetworkStartTimeoutError extends RobotNetCLIError {
  constructor(networkName: string, elapsedMs: number, logFile: string) {
    super(
      `Local operator for "${networkName}" did not become healthy within ${elapsedMs}ms. ` +
        `Inspect ${logFile} for details.`,
    );
    this.name = "NetworkStartTimeoutError";
  }
}

/** State file is unreadable or malformed; treat as "no operator running". */
export class CorruptNetworkStateError extends RobotNetCLIError {
  constructor(stateFile: string, detail: string) {
    super(
      `State file ${stateFile} is unreadable or malformed: ${detail}. ` +
        `Run \`robotnet network reset\` to clear it.`,
    );
    this.name = "CorruptNetworkStateError";
  }
}

/**
 * The configured port is already bound by some process the supervisor
 * does not own. Surfaced before spawn so the user gets an actionable
 * diagnosis ("kill the orphan, or reset") instead of a misleading
 * "operator did not become healthy within Nms" timeout from the post-
 * spawn `/healthz` probe.
 */
export class NetworkPortOccupiedError extends RobotNetCLIError {
  constructor(networkName: string, host: string, port: number) {
    super(
      `Cannot start operator for network "${networkName}": ${host}:${port} is already in use ` +
        `by a process not tracked by the supervisor. ` +
        `Find the holder with \`lsof -nP -iTCP:${port} -sTCP:LISTEN\` (or \`ss -ltnp\` on Linux), ` +
        `kill it, then re-try \`robotnet --network ${networkName} network start\`. ` +
        `If you'd rather wipe everything, \`robotnet --network ${networkName} network reset --yes\` ` +
        `also clears state but does not kill orphan processes.`,
    );
    this.name = "NetworkPortOccupiedError";
  }
}
