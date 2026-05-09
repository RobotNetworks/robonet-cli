/**
 * TypeScript wire types for the Agent Session Protocol.
 *
 * Mirror the JSON Schema definitions in `asp/schemas/{common,events,http}.json`.
 * Keep them additive — nothing here should depend on RobotNet-specific shapes.
 */

/** `@<owner>.<name>` — the canonical agent address. */
export type Handle = string;

/** Either a specific agent handle or an owner glob (`@owner.*`). */
export type AllowlistEntry = string;

/** `sess_<ULID>`. */
export type SessionId = string;

/** `msg_<ULID>`. */
export type MessageId = string;

/** `evt_<ULID>`. */
export type EventId = string;

/** Per-session monotonic sequence number (>= 0). */
export type Sequence = number;

/** Epoch milliseconds. */
export type Timestamp = number;

/** Client-supplied idempotency key (1..255 chars). */
export type IdempotencyKey = string;

/** Free-form structured metadata attached to a message or session. */
export type Metadata = Readonly<Record<string, unknown>>;

export type ParticipantStatus = "invited" | "joined" | "left";

export interface Participant {
  readonly handle: Handle;
  readonly status: ParticipantStatus;
  // The wire emits `null` (not absent) when the agent hasn't joined or
  // hasn't left. Allow both so renderers can use a loose null-check.
  readonly joined_at?: Timestamp | null;
  readonly left_at?: Timestamp | null;
}

export interface TextPart {
  readonly type: "text";
  readonly text: string;
}

/** ASP image part. RobotNet adds ``file_id`` as an operator-extension
 *  third source alongside vanilla ``url`` and ``data_uri``. Receivers
 *  resolve ``file_id`` by calling the operator's
 *  ``GET /files/{file_id}`` endpoint to mint a fresh signed URL. */
export interface ImagePart {
  readonly type: "image";
  readonly url?: string;
  readonly data_uri?: string;
  readonly file_id?: string;
  readonly mime_type?: string;
  readonly name?: string;
}

/** ASP file part. Vanilla ASP requires ``url``; RobotNet adds
 *  ``file_id`` as an operator-extension alternative. The durable
 *  transcript carries whichever form the sender used; nothing in the
 *  transcript expires, because URL minting happens at fetch time. */
export interface FilePart {
  readonly type: "file";
  readonly url?: string;
  readonly file_id?: string;
  readonly name?: string;
  readonly mime_type?: string;
  readonly size?: number;
}

export interface DataPart {
  readonly type: "data";
  readonly data: Readonly<Record<string, unknown>>;
}

export type ContentPart = TextPart | ImagePart | FilePart | DataPart;

/** Either a plain string (shorthand for one text part) or an array of
 *  typed parts. The same shape works for both write (request body) and
 *  read (durable transcript / outbound events): `file_id` references
 *  pass through unchanged on the way in, and receivers resolve them
 *  to a fresh URL via the operator's `GET /files/{file_id}` endpoint
 *  on demand. */
export type Content = string | readonly ContentPart[];

// Aliases for callers that still import the request-side names. The
// shape is identical to the durable side after the operator-extension
// landed (`file_id` is accepted on both write and read). Kept as
// aliases for drop-in source compatibility.
export type FilePartRequest = FilePart;
export type ImagePartRequest = ImagePart;
export type ContentPartRequest =
  | TextPart
  | ImagePart
  | FilePart
  | DataPart;

/** Alias for {@link Content}. Kept for source compatibility — the
 *  request and durable shapes are now identical (``file_id`` passes
 *  through unchanged). */
export type ContentRequest = Content;

export interface Message {
  readonly id: MessageId;
  readonly session_id: SessionId;
  readonly sender: Handle;
  readonly sequence: Sequence;
  readonly content: Content;
  readonly created_at: Timestamp;
  readonly idempotency_key?: IdempotencyKey;
  readonly metadata?: Metadata;
}

export type SessionState = "active" | "ended";

export type InboundPolicy = "allowlist" | "open";

export type AgentVisibility = "public" | "private";

/* -------------------------------------------------------------------------- */
/* Wire shapes returned by the network's HTTP API.                            */
/* -------------------------------------------------------------------------- */

/**
 * Read-side wire shape — `GET /_admin/agents/:handle`, `PATCH`, allowlist
 * mutations. Does not carry the bearer token: operators that hash bearers
 * at rest (RobotNet's local operator does) only return the plaintext on
 * the originating mint operation.
 *
 * `display_name`, `description`, `card_body`, and `visibility` are
 * v3-schema profile fields. Older operators that don't populate them
 * default `display_name` to the handle, `visibility` to `"private"`,
 * and the rest to `null`.
 */
export interface AgentWire {
  readonly handle: Handle;
  readonly policy: InboundPolicy;
  readonly allowlist: readonly AllowlistEntry[];
  readonly display_name: string;
  readonly description: string | null;
  readonly card_body: string | null;
  readonly visibility: AgentVisibility;
}

/**
 * Mint-side wire shape — `POST /_admin/agents` and `POST /_admin/agents/:h/rotate-token`.
 * Identical to {@link AgentWire} plus the freshly-minted bearer token.
 */
export interface AgentWithTokenWire extends AgentWire {
  readonly token: string;
}

export interface SessionWire {
  readonly id: SessionId;
  readonly state: SessionState;
  readonly topic?: string | null;
  readonly participants: readonly Participant[];
  readonly created_at: Timestamp;
  // `null` for active sessions, a Timestamp once ended.
  readonly ended_at?: Timestamp | null;
}

/* -------------------------------------------------------------------------- */
/* Session events delivered over the `/connect` WebSocket transport.          */
/* -------------------------------------------------------------------------- */

interface SessionEventBase<TType extends string, TPayload> {
  readonly type: TType;
  readonly session_id: SessionId;
  readonly event_id: EventId;
  readonly sequence: Sequence;
  readonly created_at: Timestamp;
  readonly payload: TPayload;
}

export type SessionInvitedEvent = SessionEventBase<
  "session.invited",
  {
    readonly invitee: Handle;
    readonly by: Handle;
    readonly topic?: string;
    /** Inline message body for send-and-end sessions only. */
    readonly initial_message?: Message;
  }
>;

export type SessionJoinedEvent = SessionEventBase<
  "session.joined",
  { readonly agent: Handle }
>;

export type SessionDisconnectedEvent = SessionEventBase<
  "session.disconnected",
  { readonly agent: Handle }
>;

export type SessionReconnectedEvent = SessionEventBase<
  "session.reconnected",
  { readonly agent: Handle }
>;

export type SessionLeftEvent = SessionEventBase<
  "session.left",
  {
    readonly agent: Handle;
    readonly reason?: "left" | "grace_expired";
  }
>;

export type SessionMessageEvent = SessionEventBase<"session.message", Message>;

export type SessionEndedEvent = SessionEventBase<
  "session.ended",
  { readonly ended_by?: Handle }
>;

export type SessionReopenedEvent = SessionEventBase<
  "session.reopened",
  { readonly reopened_by: Handle }
>;

/** Discriminated union of all session events delivered over `/connect`. */
export type SessionEvent =
  | SessionInvitedEvent
  | SessionJoinedEvent
  | SessionDisconnectedEvent
  | SessionReconnectedEvent
  | SessionLeftEvent
  | SessionMessageEvent
  | SessionEndedEvent
  | SessionReopenedEvent;

export type SessionEventType = SessionEvent["type"];

/**
 * Loose envelope used when receiving an event whose `type` is not yet recognised
 * — e.g. a future schema revision. Commands typically narrow to {@link SessionEvent}
 * and pass the raw event through unchanged when the discriminator misses.
 */
export interface UnknownSessionEvent {
  readonly type: string;
  readonly session_id: SessionId;
  readonly event_id: EventId;
  readonly sequence: Sequence;
  readonly created_at: Timestamp;
  readonly payload: Readonly<Record<string, unknown>>;
}
