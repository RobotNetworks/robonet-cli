import WebSocket from "ws";
import type { AgentIdentity } from "../api/models.js";
import { agentRef } from "../api/models.js";
import type { TokenResponse } from "../auth/client-credentials.js";
import type { OAuthDiscovery } from "../auth/discovery.js";
import { realtimeEventFromPayload, summarizeEvent } from "./events.js";

const DEFAULT_RECONNECT_DELAY_SECONDS = 2;
const MAX_RECONNECT_DELAY_SECONDS = 30;
const DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 30;

export interface ListenerSession {
  readonly discovery: OAuthDiscovery;
  readonly apiToken: TokenResponse;
  readonly websocketToken: TokenResponse;
  readonly identity: AgentIdentity;
}

export type LogFn = (message: string) => void;
export type StateFn = (
  health: string,
  agentRefValue: string | null,
  lastError: string | null,
  lastEventAt: number | null,
) => void;
export type SessionFactory = () => Promise<ListenerSession>;

class WebSocketClosedError extends Error {
  constructor(code: number, reason: string) {
    const suffix = reason ? ` reason=${reason}` : "";
    super(`closed code=${code}${suffix}`);
    this.name = "WebSocketClosedError";
  }
}

function timestamp(): string {
  return new Date().toISOString();
}

function log(message: string, logger: LogFn): void {
  logger(`[${timestamp()}] ${message}`);
}

export function liveNotificationNotice(agentRefValue: string): string {
  return (
    `Agent-scoped live notifications for ${agentRefValue}. ` +
    "Events are not replayed; after reconnect, use `robonet threads get <thread_id>` " +
    "or `robonet messages search` to catch up from the REST API."
  );
}

export async function listenForever(options: {
  sessionFactory: SessionFactory;
  logger: LogFn;
  stateCallback?: StateFn;
  heartbeatIntervalSeconds?: number;
}): Promise<void> {
  const {
    sessionFactory,
    logger,
    stateCallback,
    heartbeatIntervalSeconds = DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
  } = options;
  let reconnectDelay = DEFAULT_RECONNECT_DELAY_SECONDS;

  while (true) {
    try {
      stateCallback?.("starting", null, null, null);
      const session = await sessionFactory();
      stateCallback?.("starting", agentRef(session.identity), null, null);
      const currentAgentRef = agentRef(session.identity);
      log(
        `Listener session ready agent=${currentAgentRef} ws_resource=${session.websocketToken.resource}`,
        logger,
      );
      log(liveNotificationNotice(currentAgentRef), logger);
      await listenOnce({
        websocketUrl: session.websocketToken.resource,
        bearerToken: session.websocketToken.accessToken,
        logger,
        stateCallback,
        heartbeatIntervalSeconds,
      });
      reconnectDelay = DEFAULT_RECONNECT_DELAY_SECONDS;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw err;
      const errorMessage = err instanceof Error ? err.message : String(err);
      stateCallback?.("reconnecting", null, errorMessage, null);
      log(
        `WebSocket disconnected (${errorMessage}). Reconnecting in ${reconnectDelay}s...`,
        logger,
      );
      await sleep(reconnectDelay * 1000);
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_SECONDS);
    }
  }
}

function listenOnce(options: {
  websocketUrl: string;
  bearerToken: string;
  logger: LogFn;
  stateCallback?: StateFn;
  heartbeatIntervalSeconds: number;
}): Promise<void> {
  const { websocketUrl, bearerToken, logger, stateCallback, heartbeatIntervalSeconds } =
    options;

  return new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(websocketUrl, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });

    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

    ws.on("open", () => {
      stateCallback?.("connected", null, null, null);
      log(`Connected to ${websocketUrl}`, logger);
      log("Listening for agent-scoped live events... (Ctrl+C to stop)", logger);

      heartbeatTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" }));
          log("Ping sent", logger);
        }
      }, heartbeatIntervalSeconds * 1000);
    });

    ws.on("message", (data) => {
      const frame = data.toString();
      let payload: unknown;
      try {
        payload = JSON.parse(frame);
      } catch {
        log(`Non-JSON WebSocket frame: ${frame.slice(0, 200)}`, logger);
        return;
      }
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        return;
      }
      const event = realtimeEventFromPayload(payload as Record<string, unknown>);
      if (!event) return;
      stateCallback?.("connected", null, null, Date.now());
      log(`Event ${summarizeEvent(event)}`, logger);
    });

    ws.on("close", (code, reason) => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      reject(new WebSocketClosedError(code, reason.toString("utf8")));
    });

    ws.on("error", (err) => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      reject(err);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
