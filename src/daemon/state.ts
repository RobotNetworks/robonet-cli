import * as fs from "node:fs";
import * as path from "node:path";

/** Health state for the listener daemon. `starting` → `connected` → `reconnecting` on transient drop → `stopped` on shutdown, or `auth_failed` when the stored credential is server-rejected and re-login is required. */
export type DaemonHealth =
  | "starting"
  | "connected"
  | "reconnecting"
  | "stopped"
  | "auth_failed";

const VALID_HEALTH_VALUES = new Set<string>([
  "starting",
  "connected",
  "reconnecting",
  "stopped",
  "auth_failed",
]);

/** Serialized state of the listener daemon, persisted to `daemon.json` between `start`/`status`/`stop` invocations. All timestamps are epoch milliseconds. */
export interface DaemonState {
  readonly pid: number | null;
  readonly health: DaemonHealth;
  readonly websocketUrl: string;
  readonly clientId: string;
  readonly agentRef: string | null;
  readonly lastEventAt: number | null;
  readonly lastError: string | null;
  readonly updatedAt: number;
  readonly logFile: string;
}

/** Current time as epoch milliseconds; exported so daemon code uses a single time source. */
export function epochMillis(): number {
  return Date.now();
}

/** Serialize daemon state to a snake_case JSON object matching the on-disk schema. */
export function daemonStateToJson(state: DaemonState): Record<string, unknown> {
  return {
    pid: state.pid,
    health: state.health,
    websocket_url: state.websocketUrl,
    client_id: state.clientId,
    agent_ref: state.agentRef,
    last_event_at: state.lastEventAt,
    last_error: state.lastError,
    updated_at: state.updatedAt,
    log_file: state.logFile,
  };
}

/** Persist daemon state to disk with 0600 permissions; creates parent directories with 0700. */
export function saveDaemonState(filePath: string, state: DaemonState): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, JSON.stringify(daemonStateToJson(state), null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
}

/** Load daemon state from disk. Returns null if the file is missing, unreadable, or fails validation — callers treat this as "no daemon ever started". */
export function loadDaemonState(filePath: string): DaemonState | null {
  if (!fs.existsSync(filePath)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }

  const p = payload as Record<string, unknown>;
  const health = p.health;
  if (typeof health !== "string" || !VALID_HEALTH_VALUES.has(health)) return null;

  const pid = p.pid;
  if (pid !== null && pid !== undefined && typeof pid !== "number") return null;

  const lastEventAt = p.last_event_at;
  if (lastEventAt !== null && lastEventAt !== undefined && typeof lastEventAt !== "number") {
    return null;
  }

  const updatedAt = p.updated_at;
  if (typeof updatedAt !== "number") return null;

  return {
    pid: typeof pid === "number" ? pid : null,
    health: health as DaemonHealth,
    websocketUrl: typeof p.websocket_url === "string" ? p.websocket_url : "",
    clientId: typeof p.client_id === "string" ? p.client_id : "",
    agentRef: typeof p.agent_ref === "string" ? p.agent_ref : null,
    lastEventAt: typeof lastEventAt === "number" ? lastEventAt : null,
    lastError: typeof p.last_error === "string" ? p.last_error : null,
    updatedAt,
    logFile: typeof p.log_file === "string" ? p.log_file : "",
  };
}
