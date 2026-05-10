import WebSocket from "ws";

import type { SessionEvent, SessionEventType, UnknownSessionEvent } from "./types.js";

const KNOWN_EVENT_TYPES: ReadonlySet<SessionEventType> = new Set<SessionEventType>([
  "session.invited",
  "session.joined",
  "session.disconnected",
  "session.reconnected",
  "session.left",
  "session.message",
  "session.ended",
  "session.reopened",
]);

export interface AspListenerOptions {
  /** Fully-qualified WebSocket handshake URL, e.g. `ws://127.0.0.1:8723/connect` or `wss://ws.robotnet.works`. Used as-is — no path is appended. */
  readonly wsUrl: string;
  /** The calling agent's bearer token. Sent as the `Authorization: Bearer …` handshake header. */
  readonly token: string;

  readonly onOpen?: () => void;
  readonly onEvent?: (event: SessionEvent | UnknownSessionEvent, raw: string) => void;
  /** Invoked when an inbound WS frame is not valid JSON. Distinct from `onError` so callers can choose to ignore protocol noise without dropping the connection. */
  readonly onUnparseable?: (raw: string) => void;
  readonly onError?: (err: Error) => void;
  readonly onClose?: (code: number, reason: string) => void;
}

export interface AspListener {
  close(): void;
}

/**
 * Heartbeat cadence. ASP operators stamp presence on every authenticated
 * inbound frame; without a heartbeat a long-lived listener silently
 * stops looking "online" even though it's still receiving events. 30s
 * sits comfortably under typical operator presence-timeout windows.
 */
const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Open a WebSocket against the network's `/connect` endpoint and dispatch
 * inbound session events to typed callbacks.
 *
 * No automatic reconnect — callers that want resilience should observe
 * {@link AspListenerOptions.onClose} and rebuild the listener. Keeping
 * reconnect out of the primitive lets command code own the policy
 * (e.g. exit on close vs. backoff-and-retry).
 *
 * Sends a `{"type":"ping"}` frame every {@link HEARTBEAT_INTERVAL_MS} so
 * the agent stays marked online while idle. Server pongs are dispatched
 * through the same parser as any other frame; callers can ignore them
 * via {@link narrowEvent} returning `null` for non-session frames.
 */
export function startAspListener(opts: AspListenerOptions): AspListener {
  const ws = new WebSocket(opts.wsUrl, {
    headers: { Authorization: `Bearer ${opts.token}` },
  });

  let heartbeat: ReturnType<typeof setInterval> | null = null;

  ws.on("open", () => {
    heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: "ping" }));
        } catch {
          // Send-after-close races can throw — the close handler will
          // clear the interval; ignore here.
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
    opts.onOpen?.();
  });

  ws.on("message", (data) => {
    const raw = data.toString();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      opts.onUnparseable?.(raw);
      return;
    }
    // Heartbeat replies are protocol-level, not application events.
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { type?: unknown }).type === "pong"
    ) {
      return;
    }
    const event = narrowEvent(parsed);
    if (event !== null) {
      opts.onEvent?.(event, raw);
    } else {
      opts.onUnparseable?.(raw);
    }
  });

  ws.on("error", (err) => {
    opts.onError?.(err);
  });

  ws.on("close", (code, reason) => {
    if (heartbeat !== null) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    opts.onClose?.(code, reason.toString());
  });

  return {
    close: () => {
      if (heartbeat !== null) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      ws.close();
    },
  };
}

/**
 * Best-effort narrowing of a JSON-decoded event frame to one of the
 * documented session event variants. Frames that have the right envelope
 * shape but an unrecognised `type` are returned as {@link UnknownSessionEvent}
 * so forward-compatibility doesn't drop messages on the floor.
 */
function narrowEvent(value: unknown): SessionEvent | UnknownSessionEvent | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.type !== "string" ||
    typeof v.session_id !== "string" ||
    typeof v.event_id !== "string" ||
    typeof v.sequence !== "number" ||
    typeof v.created_at !== "number" ||
    typeof v.payload !== "object" ||
    v.payload === null
  ) {
    return null;
  }
  if (KNOWN_EVENT_TYPES.has(v.type as SessionEventType)) {
    return value as SessionEvent;
  }
  return value as UnknownSessionEvent;
}
