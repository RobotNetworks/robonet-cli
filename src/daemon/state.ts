import * as fs from "node:fs";
import * as path from "node:path";

export type DaemonHealth = "starting" | "connected" | "reconnecting" | "stopped";

const VALID_HEALTH_VALUES = new Set<string>(["starting", "connected", "reconnecting", "stopped"]);

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

export function epochMillis(): number {
  return Date.now();
}

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

export function saveDaemonState(filePath: string, state: DaemonState): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, JSON.stringify(daemonStateToJson(state), null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
}

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
