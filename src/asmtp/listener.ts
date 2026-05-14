import WebSocket from "ws";

import type { MonitorFact, PushFrame, ServerFrame } from "./types.js";

export interface AsmtpListenerOptions {
  /** Fully-qualified WebSocket handshake URL, e.g. `wss://example/connect`. Used as-is — no path is appended. */
  readonly wsUrl: string;
  /** The calling agent's bearer token. Sent as the `Authorization: Bearer …` handshake header. */
  readonly token: string;

  readonly onOpen?: () => void;
  readonly onFrame?: (frame: ServerFrame, raw: string) => void;
  /** Invoked when an inbound WS frame is not valid JSON or fails shape validation. */
  readonly onUnparseable?: (raw: string) => void;
  readonly onError?: (err: Error) => void;
  readonly onClose?: (code: number, reason: string) => void;
}

export interface AsmtpListener {
  close(): void;
}

/**
 * Open a WebSocket against the network's `/connect` endpoint and dispatch
 * each server-push frame to typed callbacks.
 *
 * Pure server push: the client sends nothing after the upgrade. No
 * subscribe frame, no ack, no heartbeat. Each inbound frame is parsed and
 * dispatched as either a {@link PushFrame} (`op: "envelope.notify"`) or a
 * {@link MonitorFact} (`op: "monitor.fact"`).
 *
 * No automatic reconnect — callers that want resilience should observe
 * {@link AsmtpListenerOptions.onClose} and rebuild the listener. The
 * reconnecting wrapper in `./reconnecting-listener.ts` provides the
 * standard backoff + jitter policy and resolves a fresh bearer per
 * attempt.
 */
export function startAsmtpListener(opts: AsmtpListenerOptions): AsmtpListener {
  const ws = new WebSocket(opts.wsUrl, {
    headers: { Authorization: `Bearer ${opts.token}` },
  });

  ws.on("open", () => {
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
    const frame = narrowFrame(parsed);
    if (frame !== null) {
      opts.onFrame?.(frame, raw);
    } else {
      opts.onUnparseable?.(raw);
    }
  });

  ws.on("error", (err) => {
    opts.onError?.(err);
  });

  ws.on("close", (code, reason) => {
    opts.onClose?.(code, reason.toString());
  });

  return {
    close: () => {
      ws.close();
    },
  };
}

/**
 * Best-effort narrowing of a JSON-decoded server frame. Frames that don't
 * have one of the two recognised `op` values, or that fail the shape check
 * for that op, are returned as `null` so the caller can route them to
 * `onUnparseable` instead of dropping silently.
 */
function narrowFrame(value: unknown): ServerFrame | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const op = v["op"];
  if (op === "envelope.notify") {
    return isPushFrame(v) ? (value as PushFrame) : null;
  }
  if (op === "monitor.fact") {
    return isMonitorFact(v) ? (value as MonitorFact) : null;
  }
  return null;
}

function isPushFrame(v: Record<string, unknown>): boolean {
  return (
    typeof v["id"] === "string" &&
    typeof v["from"] === "string" &&
    Array.isArray(v["to"]) &&
    typeof v["type_hint"] === "string" &&
    typeof v["created_at"] === "number" &&
    typeof v["date_ms"] === "number"
  );
}

function isMonitorFact(v: Record<string, unknown>): boolean {
  return (
    typeof v["monitor"] === "string" &&
    typeof v["envelope_id"] === "string" &&
    typeof v["recipient_handle"] === "string" &&
    typeof v["fact"] === "string" &&
    typeof v["at_ms"] === "number"
  );
}
