/**
 * Domain row types returned by the repository layer.
 *
 * Mirror the SQLite columns 1:1 (camelCase rather than snake_case) so the
 * route layer doesn't deal in raw rows. JSON columns are pre-parsed.
 * Nullability matches the schema.
 */

export type Handle = string;
export type EnvelopeId = string;
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

export type TypeHint = "text" | "image" | "file" | "data" | "mixed";

export type MailboxEntryKind = "to" | "cc";

export interface EnvelopeRecord {
  readonly id: EnvelopeId;
  readonly fromHandle: Handle;
  readonly subject: string | null;
  readonly inReplyTo: EnvelopeId | null;
  readonly dateMs: Timestamp;
  readonly receivedMs: Timestamp;
  readonly createdAtMs: Timestamp;
  readonly typeHint: TypeHint;
  readonly sizeHint: number | null;
  readonly monitorHandle: string | null;
  /** Verbatim envelope body (the JSON the operator returns from
   *  GET /messages/{id}). The route layer reads this directly. */
  readonly bodyJson: string;
}

export interface MailboxEntryRecord {
  readonly mailboxHandle: Handle;
  readonly envelopeId: EnvelopeId;
  readonly kind: MailboxEntryKind;
  readonly createdAtMs: Timestamp;
  readonly read: boolean;
}

export interface FileRecord {
  readonly id: string;
  readonly ownerHandle: Handle;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly relativePath: string;
  readonly createdAtMs: Timestamp;
}
