/**
 * Domain row types returned by the repository layer.
 *
 * These mirror the SQLite columns 1:1 (camelCase rather than snake_case) so
 * the route layer doesn't deal in raw rows. JSON columns are pre-parsed
 * into the appropriate object shapes; nullability matches the schema.
 */

export type Handle = string;
export type SessionId = string;
export type MessageId = string;
export type EventId = string;
export type Sequence = number;
export type Timestamp = number;

export type InboundPolicy = "open" | "allowlist";

export type AgentVisibility = "public" | "private";

export interface AgentRecord {
  readonly handle: Handle;
  readonly bearerTokenHash: string;
  readonly inboundPolicy: InboundPolicy;
  readonly displayName: string;
  readonly description: string | null;
  readonly cardBody: string | null;
  readonly visibility: AgentVisibility;
  readonly metadata: Readonly<Record<string, unknown>> | null;
  readonly createdAtMs: Timestamp;
  readonly updatedAtMs: Timestamp;
}

export interface AllowlistEntry {
  readonly ownerHandle: Handle;
  readonly entry: string;
  readonly createdAtMs: Timestamp;
}

export interface BlockRecord {
  readonly blockerHandle: Handle;
  readonly blockedHandle: Handle;
  readonly createdAtMs: Timestamp;
}

export type SessionState = "active" | "ended";

export interface SessionRecord {
  readonly id: SessionId;
  readonly creatorHandle: Handle;
  readonly state: SessionState;
  readonly topic: string | null;
  readonly createdAtMs: Timestamp;
  readonly updatedAtMs: Timestamp;
  readonly endedAtMs: Timestamp | null;
}

export type ParticipantStatus = "invited" | "joined" | "left";

export interface ParticipantRecord {
  readonly sessionId: SessionId;
  readonly handle: Handle;
  readonly status: ParticipantStatus;
  readonly joinedAtMs: Timestamp | null;
  readonly leftAtMs: Timestamp | null;
}

export interface MessageRecord {
  readonly id: MessageId;
  readonly sessionId: SessionId;
  readonly senderHandle: Handle;
  readonly sequence: Sequence;
  readonly content: unknown;
  readonly idempotencyKey: string | null;
  readonly metadata: Readonly<Record<string, unknown>> | null;
  readonly createdAtMs: Timestamp;
}

/**
 * Wire-shape of a stored session event.
 *
 * `type` is intentionally typed loosely (`string`) at the storage layer —
 * the route/service layer narrows to a discriminated union. Storing it as
 * a free string lets us evolve event types without a schema change.
 */
export interface EventRecord {
  readonly id: EventId;
  readonly sessionId: SessionId;
  readonly sequence: Sequence;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAtMs: Timestamp;
}

export interface DeliveryCursorRecord {
  readonly handle: Handle;
  readonly sessionId: SessionId;
  readonly lastDeliveredSequence: Sequence;
}

export interface IdempotencyRecord {
  readonly sessionId: SessionId;
  readonly senderHandle: Handle;
  readonly key: string;
  readonly messageId: MessageId;
  readonly sequence: Sequence;
  readonly createdAtMs: Timestamp;
}
