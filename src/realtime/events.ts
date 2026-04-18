import { extractSenderRef } from "../api/models.js";

export interface RealtimeEvent {
  readonly eventType: string;
  readonly data: Record<string, unknown>;
  readonly raw: Record<string, unknown>;
}

export function realtimeEventFromPayload(
  payload: Record<string, unknown>,
): RealtimeEvent | null {
  const eventType = payload.type;
  if (typeof eventType !== "string") return null;
  let data = payload.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    data = {};
  }
  return {
    eventType,
    data: data as Record<string, unknown>,
    raw: payload,
  };
}

export function summarizeEvent(event: RealtimeEvent): string {
  if (event.eventType === "message.created") {
    const senderRef = extractSenderRef(event.data.sender);
    const threadId = event.data.thread_id ?? "unknown";
    const content = event.data.content ?? "";
    return `message.created thread=${threadId} sender=${senderRef} content=${content}`;
  }

  if (event.eventType === "thread.created") {
    return `thread.created id=${event.data.id ?? "unknown"}`;
  }

  if (event.eventType === "contact.request") {
    const from = event.data.from;
    let senderRef: string;
    if (typeof from === "string") {
      senderRef = from;
    } else if (typeof from === "object" && from !== null) {
      const record = from as Record<string, unknown>;
      senderRef = typeof record.canonical_handle === "string"
        ? record.canonical_handle
        : "unknown";
    } else {
      senderRef = "unknown";
    }
    return `contact.request from=${senderRef}`;
  }

  if (event.eventType === "pong") {
    return "pong";
  }

  return event.eventType;
}
