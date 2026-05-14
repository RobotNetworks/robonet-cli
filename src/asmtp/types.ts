/**
 * TypeScript wire types for the asynchronous mailbox-style envelope protocol.
 *
 * Mirror the JSON Schema definitions of the public wire surface (envelope,
 * envelope-post, push-frame, monitor, http, ws). Keep additive — nothing here
 * should depend on operator-specific shapes.
 */

/** `@<owner>.<name>` — the canonical agent address. */
export type Handle = string;

/** Either a specific agent handle or an owner glob (`@owner.*`). */
export type AllowlistEntry = string;

/** Sender-allocated ULID, 26 Crockford-base32 chars. Globally unique. */
export type EnvelopeId = string;

/** Sender-allocated opt-in monitor handle, `mon_<token>`. */
export type MonitorHandle = string;

/** Epoch milliseconds. */
export type Timestamp = number;

/* -------------------------------------------------------------------------- */
/* Content parts                                                              */
/* -------------------------------------------------------------------------- */

export interface TextPart {
  readonly type: "text";
  readonly text: string;
}

export interface ImagePart {
  readonly type: "image";
  /**
   * Exactly one of `url` / `file_id` is set. `url` is the ASMTP wire
   * shape — what receivers fetch. `file_id` is the Robot Networks
   * operator extension: the sender uploads bytes via `POST /files`,
   * receives an opaque `file_…` id, and embeds that here. The
   * operator resolves `file_id` to `url` at envelope-accept time, so
   * the stored envelope always carries `url` for downstream wire
   * compatibility. Operators that don't host uploads ignore
   * `file_id` and require `url`.
   */
  readonly url?: string;
  readonly file_id?: string;
  readonly mime_type?: string;
}

export interface FilePart {
  readonly type: "file";
  /** See `ImagePart`. Exactly one of `url` / `file_id` is set. */
  readonly url?: string;
  readonly file_id?: string;
  readonly name?: string;
  readonly mime_type?: string;
  readonly size?: number;
}

export interface DataPart {
  readonly type: "data";
  readonly schema?: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export type ContentPart = TextPart | ImagePart | FilePart | DataPart;

export type ContentParts = readonly ContentPart[];

/* -------------------------------------------------------------------------- */
/* Envelope shapes                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Coarse hint about the body's dominant content type. Appears on push
 * frames and mailbox listings; helps the receiver triage before fetching.
 */
export type TypeHint = "text" | "image" | "file" | "data" | "mixed";

/**
 * Wire body of `POST /messages`. Identical to {@link Envelope} except
 * `from` is absent — the operator stamps it from the authenticated identity.
 */
export interface EnvelopePost {
  readonly id: EnvelopeId;
  readonly to: readonly Handle[];
  readonly cc?: readonly Handle[];
  readonly subject?: string;
  readonly in_reply_to?: EnvelopeId;
  readonly references?: readonly EnvelopeId[];
  readonly date_ms: Timestamp;
  readonly content_parts: ContentParts;
  readonly monitor?: MonitorHandle;
}

/** Stored / fetched envelope shape returned by `GET /messages/{id}` and batch GET. */
export interface Envelope extends EnvelopePost {
  readonly from: Handle;
}

/* -------------------------------------------------------------------------- */
/* Wire responses                                                             */
/* -------------------------------------------------------------------------- */

export interface PostMessagesRecipient {
  readonly handle: Handle;
}

export interface PostMessagesResponse {
  readonly id: EnvelopeId;
  readonly received_ms: Timestamp;
  readonly created_at: Timestamp;
  readonly recipients: readonly PostMessagesRecipient[];
}

/**
 * Header-only notification on the WebSocket. The same shape is returned in
 * `GET /mailbox` listings. Bodies are explicitly forbidden — clients fetch
 * via `GET /messages/{id}` (which also marks read).
 */
export interface PushFrame {
  readonly op: "envelope.notify";
  readonly id: EnvelopeId;
  readonly from: Handle;
  readonly to: readonly Handle[];
  readonly cc?: readonly Handle[];
  readonly subject?: string;
  readonly in_reply_to?: EnvelopeId;
  readonly type_hint: TypeHint;
  readonly size_hint?: number;
  readonly created_at: Timestamp;
  readonly date_ms: Timestamp;
}

export type MonitorFactKind = "stored" | "bounced" | "expired";

export interface MonitorFact {
  readonly op: "monitor.fact";
  readonly monitor: MonitorHandle;
  readonly envelope_id: EnvelopeId;
  readonly recipient_handle: Handle;
  readonly fact: MonitorFactKind;
  readonly at_ms: Timestamp;
}

/**
 * Discriminated union of frames the server pushes on `WS /connect`. The wire
 * is server-push only; clients send nothing.
 */
export type ServerFrame = PushFrame | MonitorFact;

export interface MailboxCursor {
  readonly created_at: Timestamp;
  readonly envelope_id: EnvelopeId;
}

export interface GetMailboxResponse {
  readonly envelope_headers: readonly PushFrame[];
  readonly next_cursor: MailboxCursor | null;
}

export interface GetMessagesBatchResponse {
  readonly envelopes: readonly Envelope[];
}

export interface PostReadResponse {
  readonly read: readonly EnvelopeId[];
}

/* -------------------------------------------------------------------------- */
/* Files (URL-mint surface used by the CLI's send pipeline)                   */
/* -------------------------------------------------------------------------- */

/**
 * Response from `POST /files` on a Robot Networks-style operator: the
 * upload returns an opaque `id` plus metadata. There is no `url` in
 * the response — the sender embeds `{type:"file", file_id:"file_…"}`
 * (or `{type:"image", file_id:"file_…"}`) on the outbound envelope
 * and the operator resolves the id to a signed URL at envelope-accept
 * time. Receivers fetch bytes via `GET /files/{id}`.
 *
 * `status` is the operator's upload lifecycle state; `expires_at` is
 * an operator-stamped epoch-ms TTL after which the bytes are no
 * longer addressable (the operator may garbage-collect).
 */
export interface PostFileResponse {
  readonly id: string;
  readonly status: string;
  readonly filename: string;
  readonly content_type: string;
  readonly size_bytes: number;
  readonly created_at: number;
  readonly expires_at: number;
}

/* -------------------------------------------------------------------------- */
/* Operator-side shapes the CLI also exposes to admin / discovery callers    */
/* -------------------------------------------------------------------------- */

export type InboundPolicy = "allowlist" | "open";

export type AgentVisibility = "public" | "private";

/**
 * Read-side admin wire shape — `GET /_admin/agents/:handle`, `PATCH`,
 * allowlist mutations. Bearer is included only on mint operations (see
 * {@link AgentWithTokenWire}); subsequent reads omit it because operators
 * hash bearers at rest and the plaintext is unrecoverable.
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
 * Mint-side admin wire shape — `POST /_admin/agents` and rotate-token
 * responses. Identical to {@link AgentWire} plus the freshly-minted bearer.
 */
export interface AgentWithTokenWire extends AgentWire {
  readonly token: string;
}
