import WebSocket from "ws";
import type { AgentIdentity } from "../api/models.js";
import { agentRef } from "../api/models.js";
import type { TokenResponse } from "../auth/client-credentials.js";
import type { OAuthDiscovery } from "../auth/discovery.js";
import { AuthenticationError } from "../errors.js";
import { realtimeEventFromPayload, summarizeEvent } from "./events.js";

const DEFAULT_RECONNECT_DELAY_SECONDS = 2;
const MAX_RECONNECT_DELAY_SECONDS = 30;
const DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 30;

/** A fully-authenticated listener session: OAuth discovery results, separately-scoped API and WebSocket tokens, and the resolved agent identity. */
export interface ListenerSession {
  readonly discovery: OAuthDiscovery;
  readonly apiToken: TokenResponse;
  readonly websocketToken: TokenResponse;
  readonly identity: AgentIdentity;
}

/** Callback used by the listener to emit a single log line. */
export type LogFn = (message: string) => void;
/** Callback invoked whenever the listener's health or last-event timestamp changes. `lastEventAt` is epoch milliseconds. */
export type StateFn = (
  health: string,
  agentRefValue: string | null,
  lastError: string | null,
  lastEventAt: number | null,
) => void;
/** Factory that produces a fresh {@link ListenerSession}, called on initial connect and on every reconnect. */
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

/** Human-readable notice explaining that RoboNet realtime events are live-only (not replayed after reconnect). */
export function liveNotificationNotice(agentRefValue: string): string {
  return (
    `Agent-scoped live notifications for ${agentRefValue}. ` +
    "Events are not replayed; after reconnect, use `robonet threads get <thread_id>` " +
    "or `robonet messages search` to catch up from the REST API."
  );
}

/**
 * Maintain a WebSocket connection until told to stop, reconnecting with exponential
 * backoff (2s → 30s) on transient drops. The `sessionFactory` is re-invoked on each
 * reconnect so expired tokens are refreshed. Re-throws any {@link AuthenticationError}
 * (stored credentials missing, malformed, or server-rejected) so the caller can
 * surface a re-login prompt; otherwise runs indefinitely.
 *
 * Logging is event-only by default: `logger` is invoked for each realtime event
 * delivered by the server. Set `verbose: true` to also log connection diagnostics
 * (session lifecycle, connect/disconnect, reconnect backoff, heartbeat ping/pong,
 * and the auth-failure final message). State transitions are always reported via
 * `stateCallback` regardless of verbosity.
 */
export async function listenForever(options: {
  sessionFactory: SessionFactory;
  logger: LogFn;
  stateCallback?: StateFn;
  heartbeatIntervalSeconds?: number;
  verbose?: boolean;
}): Promise<void> {
  const {
    sessionFactory,
    logger,
    stateCallback,
    heartbeatIntervalSeconds = DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
    verbose = false,
  } = options;
  let reconnectDelay = DEFAULT_RECONNECT_DELAY_SECONDS;

  while (true) {
    try {
      stateCallback?.("starting", null, null, null);
      const session = await sessionFactory();
      stateCallback?.("starting", agentRef(session.identity), null, null);
      const currentAgentRef = agentRef(session.identity);
      if (verbose) {
        log(
          `Listener session ready agent=${currentAgentRef} ws_resource=${session.websocketToken.resource}`,
          logger,
        );
        log(liveNotificationNotice(currentAgentRef), logger);
      }
      await listenOnce({
        websocketUrl: session.websocketToken.resource,
        bearerToken: session.websocketToken.accessToken,
        logger,
        stateCallback,
        heartbeatIntervalSeconds,
        verbose,
      });
      reconnectDelay = DEFAULT_RECONNECT_DELAY_SECONDS;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw err;
      const errorMessage = err instanceof Error ? err.message : String(err);
      if (err instanceof AuthenticationError) {
        stateCallback?.("auth_failed", null, errorMessage, null);
        if (verbose) {
          log(`Listener stopped: ${errorMessage}`, logger);
        }
        throw err;
      }
      stateCallback?.("reconnecting", null, errorMessage, null);
      if (verbose) {
        log(
          `WebSocket disconnected (${errorMessage}). Reconnecting in ${reconnectDelay}s...`,
          logger,
        );
      }
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
  verbose: boolean;
}): Promise<void> {
  const {
    websocketUrl,
    bearerToken,
    logger,
    stateCallback,
    heartbeatIntervalSeconds,
    verbose,
  } = options;

  return new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(websocketUrl, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });

    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

    ws.on("open", () => {
      stateCallback?.("connected", null, null, null);
      if (verbose) {
        log(`Connected to ${websocketUrl}`, logger);
        log("Listening for agent-scoped live events... (Ctrl+C to stop)", logger);
      }

      heartbeatTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" }));
          if (verbose) log("Ping sent", logger);
        }
      }, heartbeatIntervalSeconds * 1000);
    });

    ws.on("message", (data) => {
      const frame = data.toString();
      let payload: unknown;
      try {
        payload = JSON.parse(frame);
      } catch {
        if (verbose) {
          log(`Non-JSON WebSocket frame: ${frame.slice(0, 200)}`, logger);
        }
        return;
      }
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        return;
      }
      const event = realtimeEventFromPayload(payload as Record<string, unknown>);
      if (!event) return;
      stateCallback?.("connected", null, null, Date.now());
      if (event.eventType === "pong" && !verbose) return;
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
