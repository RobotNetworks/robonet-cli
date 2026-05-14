import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { withTransaction } from "./transaction.js";
import type {
  AgentRecord,
  AgentVisibility,
  AllowlistEntry,
  BlockRecord,
  EnvelopeId,
  EnvelopeRecord,
  FileRecord,
  Handle,
  InboundPolicy,
  MailboxEntryKind,
  MailboxEntryRecord,
  Timestamp,
  TypeHint,
} from "./types.js";

/* -------------------------------------------------------------------------- */
/* Repository facade                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Bundle of typed accessors over the operator's SQLite database. The
 * service layer composes these inside `withTransaction(db, ...)` blocks;
 * the repos themselves don't open transactions so the caller controls
 * atomicity boundaries.
 */
export class OperatorRepository {
  readonly agents: AgentsRepo;
  readonly blocks: BlocksRepo;
  readonly envelopes: EnvelopesRepo;
  readonly mailbox: MailboxRepo;
  readonly files: FilesRepo;

  constructor(db: DatabaseSync) {
    this.agents = new AgentsRepo(db);
    this.blocks = new BlocksRepo(db);
    this.envelopes = new EnvelopesRepo(db);
    this.mailbox = new MailboxRepo(db);
    this.files = new FilesRepo(db);
  }
}

/* -------------------------------------------------------------------------- */
/* Agents + allowlist                                                          */
/* -------------------------------------------------------------------------- */

export interface RegisterAgentInput {
  readonly handle: Handle;
  readonly bearerTokenHash: string;
  readonly inboundPolicy?: InboundPolicy;
  readonly displayName?: string;
  readonly description?: string | null;
  readonly cardBody?: string | null;
  readonly visibility?: AgentVisibility;
  readonly metadata?: Readonly<Record<string, unknown>> | null;
}

export interface UpdateAgentProfileInput {
  readonly displayName?: string;
  readonly description?: string | null;
  readonly cardBody?: string | null;
  readonly visibility?: AgentVisibility;
}

export class AgentsRepo {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  register(input: RegisterAgentInput): AgentRecord {
    const now = Date.now();
    const policy = input.inboundPolicy ?? "allowlist";
    const displayName = input.displayName ?? input.handle;
    const visibility = input.visibility ?? "private";
    const metadataJson =
      input.metadata !== undefined && input.metadata !== null
        ? JSON.stringify(input.metadata)
        : null;
    this.#db
      .prepare(
        `INSERT INTO agents (
           handle, bearer_token_hash, inbound_policy,
           display_name, description, card_body, visibility,
           metadata_json, created_at_ms, updated_at_ms
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.handle,
        input.bearerTokenHash,
        policy,
        displayName,
        input.description ?? null,
        input.cardBody ?? null,
        visibility,
        metadataJson,
        now,
        now,
      );
    const got = this.byHandle(input.handle);
    if (got === null) {
      throw new Error(
        `internal: agent ${input.handle} disappeared immediately after insert`,
      );
    }
    return got;
  }

  updateProfile(
    handle: Handle,
    input: UpdateAgentProfileInput,
  ): AgentRecord | null {
    const sets: string[] = [];
    const params: SQLInputValue[] = [];
    if (input.displayName !== undefined) {
      sets.push("display_name = ?");
      params.push(input.displayName);
    }
    if (input.description !== undefined) {
      sets.push("description = ?");
      params.push(input.description);
    }
    if (input.cardBody !== undefined) {
      sets.push("card_body = ?");
      params.push(input.cardBody);
    }
    if (input.visibility !== undefined) {
      sets.push("visibility = ?");
      params.push(input.visibility);
    }
    if (sets.length === 0) {
      return this.byHandle(handle);
    }
    sets.push("updated_at_ms = ?");
    params.push(Date.now());
    params.push(handle);
    const info = this.#db
      .prepare(`UPDATE agents SET ${sets.join(", ")} WHERE handle = ?`)
      .run(...params);
    if (info.changes === 0) return null;
    return this.byHandle(handle);
  }

  byHandle(handle: Handle): AgentRecord | null {
    const row = this.#db
      .prepare("SELECT * FROM agents WHERE handle = ?")
      .get(handle) as unknown as RawAgentRow | undefined;
    return row === undefined ? null : rawToAgent(row);
  }

  byBearerHash(hash: string): AgentRecord | null {
    const row = this.#db
      .prepare("SELECT * FROM agents WHERE bearer_token_hash = ?")
      .get(hash) as unknown as RawAgentRow | undefined;
    return row === undefined ? null : rawToAgent(row);
  }

  list(): readonly AgentRecord[] {
    const rows = this.#db
      .prepare("SELECT * FROM agents ORDER BY handle")
      .all() as unknown as RawAgentRow[];
    return rows.map(rawToAgent);
  }

  search(query: string, limit: number): readonly AgentRecord[] {
    return this.searchPage({ query, limit });
  }

  searchPage(args: {
    readonly query: string;
    readonly limit: number;
    readonly afterHandle?: string;
  }): readonly AgentRecord[] {
    const pattern = `%${escapeLike(args.query)}%`;
    const after = args.afterHandle ?? "";
    const rows = this.#db
      .prepare(
        `SELECT * FROM agents
         WHERE (handle LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')
           AND handle > ?
         ORDER BY handle
         LIMIT ?`,
      )
      .all(pattern, pattern, after, args.limit) as unknown as RawAgentRow[];
    return rows.map(rawToAgent);
  }

  /**
   * Remove an agent and all rows that reference it. Cascades through the
   * dependent FKs (allowlist, blocks, mailbox_entries, files,
   * envelopes-they-sent). Wrapped in a transaction so a partial failure
   * rolls back. Returns true iff the agent existed.
   */
  remove(handle: Handle): boolean {
    const changes = withTransaction(this.#db, () => {
      // Envelopes the agent SENT cascade their mailbox entries through
      // `envelopes(id)` cascade. The agent's OWN mailbox entries cascade
      // through `mailbox_entries.mailbox_handle`. Both cascades fire from
      // the agent row delete; we don't need explicit cleanup.
      return this.#db.prepare("DELETE FROM agents WHERE handle = ?").run(handle)
        .changes;
    });
    return changes > 0;
  }

  rotateBearerHash(handle: Handle, newHash: string): boolean {
    const now = Date.now();
    return (
      this.#db
        .prepare(
          "UPDATE agents SET bearer_token_hash = ?, updated_at_ms = ? WHERE handle = ?",
        )
        .run(newHash, now, handle).changes > 0
    );
  }

  setInboundPolicy(handle: Handle, policy: InboundPolicy): boolean {
    const now = Date.now();
    return (
      this.#db
        .prepare(
          "UPDATE agents SET inbound_policy = ?, updated_at_ms = ? WHERE handle = ?",
        )
        .run(policy, now, handle).changes > 0
    );
  }

  /* -- allowlist ---------------------------------------------------------- */

  addAllowlistEntry(ownerHandle: Handle, entry: string): AllowlistEntry {
    const now = Date.now();
    this.#db
      .prepare(
        `INSERT INTO allowlist (owner_handle, entry, created_at_ms) VALUES (?, ?, ?)
         ON CONFLICT (owner_handle, entry) DO NOTHING`,
      )
      .run(ownerHandle, entry, now);
    const got = this.#db
      .prepare(
        "SELECT * FROM allowlist WHERE owner_handle = ? AND entry = ?",
      )
      .get(ownerHandle, entry) as unknown as RawAllowlistRow | undefined;
    if (got === undefined) {
      throw new Error(
        `internal: allowlist row missing after upsert (${ownerHandle}, ${entry})`,
      );
    }
    return rawToAllowlist(got);
  }

  removeAllowlistEntry(ownerHandle: Handle, entry: string): boolean {
    return (
      this.#db
        .prepare("DELETE FROM allowlist WHERE owner_handle = ? AND entry = ?")
        .run(ownerHandle, entry).changes > 0
    );
  }

  listAllowlist(ownerHandle: Handle): readonly AllowlistEntry[] {
    const rows = this.#db
      .prepare("SELECT * FROM allowlist WHERE owner_handle = ? ORDER BY entry")
      .all(ownerHandle) as unknown as RawAllowlistRow[];
    return rows.map(rawToAllowlist);
  }
}

/* -------------------------------------------------------------------------- */
/* Blocks                                                                      */
/* -------------------------------------------------------------------------- */

interface RawBlockRow {
  readonly blocker_handle: string;
  readonly blocked_handle: string;
  readonly created_at_ms: number;
}

function rawToBlock(row: RawBlockRow): BlockRecord {
  return {
    blockerHandle: row.blocker_handle,
    blockedHandle: row.blocked_handle,
    createdAtMs: row.created_at_ms,
  };
}

export class BlocksRepo {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  add(blockerHandle: Handle, blockedHandle: Handle): BlockRecord {
    const now = Date.now();
    this.#db
      .prepare(
        `INSERT INTO blocks (blocker_handle, blocked_handle, created_at_ms)
         VALUES (?, ?, ?)
         ON CONFLICT (blocker_handle, blocked_handle) DO NOTHING`,
      )
      .run(blockerHandle, blockedHandle, now);
    const got = this.#db
      .prepare(
        `SELECT * FROM blocks WHERE blocker_handle = ? AND blocked_handle = ?`,
      )
      .get(blockerHandle, blockedHandle) as unknown as RawBlockRow | undefined;
    if (got === undefined) {
      throw new Error(
        `internal: block row missing after upsert (${blockerHandle} > ${blockedHandle})`,
      );
    }
    return rawToBlock(got);
  }

  remove(blockerHandle: Handle, blockedHandle: Handle): boolean {
    return (
      this.#db
        .prepare(
          `DELETE FROM blocks WHERE blocker_handle = ? AND blocked_handle = ?`,
        )
        .run(blockerHandle, blockedHandle).changes > 0
    );
  }

  isBlocked(blockerHandle: Handle, blockedHandle: Handle): boolean {
    const row = this.#db
      .prepare(
        "SELECT 1 FROM blocks WHERE blocker_handle = ? AND blocked_handle = ?",
      )
      .get(blockerHandle, blockedHandle);
    return row !== undefined;
  }

  list(
    blockerHandle: Handle,
    opts: { readonly limit?: number; readonly offset?: number } = {},
  ): readonly BlockRecord[] {
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;
    const rows = this.#db
      .prepare(
        `SELECT * FROM blocks
         WHERE blocker_handle = ?
         ORDER BY created_at_ms DESC, blocked_handle ASC
         LIMIT ? OFFSET ?`,
      )
      .all(blockerHandle, limit, offset) as unknown as RawBlockRow[];
    return rows.map(rawToBlock);
  }
}

/* -------------------------------------------------------------------------- */
/* Envelopes                                                                   */
/* -------------------------------------------------------------------------- */

export interface InsertEnvelopeInput {
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
  readonly bodyJson: string;
}

export class EnvelopesRepo {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  insert(input: InsertEnvelopeInput): EnvelopeRecord {
    this.#db
      .prepare(
        `INSERT INTO envelopes (
           id, from_handle, subject, in_reply_to,
           date_ms, received_ms, created_at_ms,
           type_hint, size_hint, monitor_handle, body_json
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.fromHandle,
        input.subject,
        input.inReplyTo,
        input.dateMs,
        input.receivedMs,
        input.createdAtMs,
        input.typeHint,
        input.sizeHint,
        input.monitorHandle,
        input.bodyJson,
      );
    const got = this.byId(input.id);
    if (got === null) {
      throw new Error(`internal: envelope ${input.id} missing after insert`);
    }
    return got;
  }

  byId(id: EnvelopeId): EnvelopeRecord | null {
    const row = this.#db
      .prepare("SELECT * FROM envelopes WHERE id = ?")
      .get(id) as unknown as RawEnvelopeRow | undefined;
    return row === undefined ? null : rawToEnvelope(row);
  }

  /** Fetch many envelopes by id, preserving the input order (after dedupe). */
  byIds(ids: readonly EnvelopeId[]): readonly EnvelopeRecord[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.#db
      .prepare(
        `SELECT * FROM envelopes WHERE id IN (${placeholders})`,
      )
      .all(...ids) as unknown as RawEnvelopeRow[];
    const byId = new Map<string, EnvelopeRecord>();
    for (const r of rows) byId.set(r.id, rawToEnvelope(r));
    const seen = new Set<string>();
    const out: EnvelopeRecord[] = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const rec = byId.get(id);
      if (rec !== undefined) out.push(rec);
    }
    return out;
  }

  /**
   * Substring search for envelopes a `recipient` is on, matching `query`
   * against `subject` or the JSON-encoded body. Recipient filter is
   * enforced via the join: an envelope only surfaces if the caller's
   * `mailbox_handle` row exists. Results are ordered newest-first by
   * `(created_at_ms DESC, id DESC)` — matches the admin UI default and
   * the hosted backend's relevance-ordered shape closely enough for
   * local-network UX (production operators substitute a real text index).
   *
   * `%` and `_` in `query` are escaped so a hostile or accidental
   * wildcard doesn't widen the match.
   */
  searchForRecipient(opts: {
    readonly recipientHandle: Handle;
    readonly query: string;
    readonly limit: number;
  }): readonly EnvelopeRecord[] {
    const like = `%${escapeLike(opts.query)}%`;
    const rows = this.#db
      .prepare(
        `SELECT DISTINCT e.*
         FROM envelopes e
         JOIN mailbox_entries m ON m.envelope_id = e.id
         WHERE m.mailbox_handle = ?
           AND (e.subject LIKE ? ESCAPE '\\' OR e.body_json LIKE ? ESCAPE '\\')
         ORDER BY e.created_at_ms DESC, e.id DESC
         LIMIT ?`,
      )
      .all(
        opts.recipientHandle,
        like,
        like,
        opts.limit,
      ) as unknown as RawEnvelopeRow[];
    return rows.map(rawToEnvelope);
  }
}

/* -------------------------------------------------------------------------- */
/* Mailbox entries                                                             */
/* -------------------------------------------------------------------------- */

export interface InsertMailboxEntryInput {
  readonly mailboxHandle: Handle;
  readonly envelopeId: EnvelopeId;
  readonly kind: MailboxEntryKind;
  readonly createdAtMs: Timestamp;
}

export interface MailboxKeysetQuery {
  readonly mailboxHandle: Handle;
  readonly order: "asc" | "desc";
  readonly limit: number;
  readonly unread?: boolean;
  readonly afterCreatedAt?: Timestamp;
  readonly afterEnvelopeId?: EnvelopeId;
  /** Lookback window for `asc` mode, in milliseconds. Defaults to 30s. */
  readonly lookbackMs?: number;
}

export class MailboxRepo {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  insert(input: InsertMailboxEntryInput): MailboxEntryRecord {
    this.#db
      .prepare(
        `INSERT INTO mailbox_entries
           (mailbox_handle, envelope_id, kind, created_at_ms, read)
         VALUES (?, ?, ?, ?, 0)`,
      )
      .run(input.mailboxHandle, input.envelopeId, input.kind, input.createdAtMs);
    return {
      mailboxHandle: input.mailboxHandle,
      envelopeId: input.envelopeId,
      kind: input.kind,
      createdAtMs: input.createdAtMs,
      read: false,
    };
  }

  get(
    mailboxHandle: Handle,
    envelopeId: EnvelopeId,
  ): MailboxEntryRecord | null {
    const row = this.#db
      .prepare(
        "SELECT * FROM mailbox_entries WHERE mailbox_handle = ? AND envelope_id = ?",
      )
      .get(mailboxHandle, envelopeId) as unknown as RawMailboxRow | undefined;
    return row === undefined ? null : rawToMailboxEntry(row);
  }

  /**
   * Keyset-paginated list. `asc` applies the 30s lookback overlap on the
   * timestamp leg; `desc` uses strict tuple compare with no overlap.
   */
  list(q: MailboxKeysetQuery): readonly MailboxEntryRecord[] {
    const lookback = q.lookbackMs ?? 30_000;
    const params: SQLInputValue[] = [q.mailboxHandle];
    const filters: string[] = ["mailbox_handle = ?"];

    if (q.unread === true) {
      filters.push("read = 0");
    } else if (q.unread === false) {
      filters.push("read = 1");
    }

    const hasCursor =
      q.afterCreatedAt !== undefined && q.afterEnvelopeId !== undefined;

    if (q.order === "asc") {
      if (hasCursor) {
        // Floor the candidate timestamp at (cursor.created_at - lookback)
        // so a late-committed envelope past the client's last seen pair
        // resurfaces on the next page.
        filters.push("created_at_ms >= ?");
        params.push(q.afterCreatedAt! - lookback);
      }
      const orderClause = "ORDER BY created_at_ms ASC, envelope_id ASC";
      params.push(q.limit);
      const rows = this.#db
        .prepare(
          `SELECT * FROM mailbox_entries
           WHERE ${filters.join(" AND ")}
           ${orderClause}
           LIMIT ?`,
        )
        .all(...params) as unknown as RawMailboxRow[];
      return rows.map(rawToMailboxEntry);
    }

    // desc: strict tuple compare, no lookback.
    if (hasCursor) {
      filters.push(
        "(created_at_ms < ? OR (created_at_ms = ? AND envelope_id < ?))",
      );
      params.push(q.afterCreatedAt!, q.afterCreatedAt!, q.afterEnvelopeId!);
    }
    const orderClause = "ORDER BY created_at_ms DESC, envelope_id DESC";
    params.push(q.limit);
    const rows = this.#db
      .prepare(
        `SELECT * FROM mailbox_entries
         WHERE ${filters.join(" AND ")}
         ${orderClause}
         LIMIT ?`,
      )
      .all(...params) as unknown as RawMailboxRow[];
    return rows.map(rawToMailboxEntry);
  }

  /**
   * Mark `(mailbox_handle, envelope_id)` rows as read for the ids the
   * caller owns. Returns the ids actually flipped (already-read rows are
   * silently skipped); ids the caller doesn't own never appear in the
   * result, preserving non-enumeration of other agents' mailboxes.
   */
  markRead(
    mailboxHandle: Handle,
    envelopeIds: readonly EnvelopeId[],
  ): readonly EnvelopeId[] {
    if (envelopeIds.length === 0) return [];
    const flipped: EnvelopeId[] = [];
    const stmt = this.#db.prepare(
      "UPDATE mailbox_entries SET read = 1 WHERE mailbox_handle = ? AND envelope_id = ?",
    );
    for (const id of envelopeIds) {
      const info = stmt.run(mailboxHandle, id);
      if (info.changes > 0) flipped.push(id);
    }
    return flipped;
  }

  /** Recipient handles for an envelope (`to` + `cc`), in insertion order. */
  recipientsFor(envelopeId: EnvelopeId): readonly Handle[] {
    const rows = this.#db
      .prepare(
        "SELECT mailbox_handle FROM mailbox_entries WHERE envelope_id = ? ORDER BY rowid",
      )
      .all(envelopeId) as unknown as { mailbox_handle: string }[];
    return rows.map((r) => r.mailbox_handle);
  }
}

/* -------------------------------------------------------------------------- */
/* Files                                                                       */
/* -------------------------------------------------------------------------- */

export interface RegisterFileInput {
  readonly id: string;
  readonly ownerHandle: Handle;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly relativePath: string;
}

export class FilesRepo {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  register(input: RegisterFileInput): FileRecord {
    const now = Date.now();
    this.#db
      .prepare(
        `INSERT INTO files (
          id, owner_handle, filename, content_type, size_bytes, relative_path, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.ownerHandle,
        input.filename,
        input.contentType,
        input.sizeBytes,
        input.relativePath,
        now,
      );
    const got = this.byId(input.id);
    if (got === null) {
      throw new Error(`internal: file row missing after insert (${input.id})`);
    }
    return got;
  }

  byId(id: string): FileRecord | null {
    const row = this.#db
      .prepare("SELECT * FROM files WHERE id = ?")
      .get(id) as unknown as RawFileRow | undefined;
    return row === undefined ? null : rawToFile(row);
  }
}

/* -------------------------------------------------------------------------- */
/* Raw row > domain mappers                                                    */
/* -------------------------------------------------------------------------- */

interface RawAgentRow {
  handle: string;
  bearer_token_hash: string;
  inbound_policy: InboundPolicy;
  display_name: string | null;
  description: string | null;
  card_body: string | null;
  visibility: AgentVisibility | null;
  metadata_json: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

interface RawAllowlistRow {
  owner_handle: string;
  entry: string;
  created_at_ms: number;
}

interface RawEnvelopeRow {
  id: string;
  from_handle: string;
  subject: string | null;
  in_reply_to: string | null;
  date_ms: number;
  received_ms: number;
  created_at_ms: number;
  type_hint: TypeHint;
  size_hint: number | null;
  monitor_handle: string | null;
  body_json: string;
}

interface RawMailboxRow {
  mailbox_handle: string;
  envelope_id: string;
  kind: MailboxEntryKind;
  created_at_ms: number;
  read: number;
}

interface RawFileRow {
  id: string;
  owner_handle: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  relative_path: string;
  created_at_ms: number;
}

function parseJsonObject(json: string): Readonly<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`stored JSON is not an object: ${json.slice(0, 80)}`);
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function parseOptionalJsonObject(
  json: string | null,
): Readonly<Record<string, unknown>> | null {
  return json === null ? null : parseJsonObject(json);
}

function escapeLike(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/[%_]/g, "\\$&");
}

function rawToAgent(row: RawAgentRow): AgentRecord {
  return {
    handle: row.handle,
    bearerTokenHash: row.bearer_token_hash,
    inboundPolicy: row.inbound_policy,
    displayName: row.display_name ?? row.handle,
    description: row.description,
    cardBody: row.card_body,
    visibility: row.visibility ?? "private",
    metadata: parseOptionalJsonObject(row.metadata_json),
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

function rawToAllowlist(row: RawAllowlistRow): AllowlistEntry {
  return {
    ownerHandle: row.owner_handle,
    entry: row.entry,
    createdAtMs: row.created_at_ms,
  };
}

function rawToEnvelope(row: RawEnvelopeRow): EnvelopeRecord {
  return {
    id: row.id,
    fromHandle: row.from_handle,
    subject: row.subject,
    inReplyTo: row.in_reply_to,
    dateMs: row.date_ms,
    receivedMs: row.received_ms,
    createdAtMs: row.created_at_ms,
    typeHint: row.type_hint,
    sizeHint: row.size_hint,
    monitorHandle: row.monitor_handle,
    bodyJson: row.body_json,
  };
}

function rawToMailboxEntry(row: RawMailboxRow): MailboxEntryRecord {
  return {
    mailboxHandle: row.mailbox_handle,
    envelopeId: row.envelope_id,
    kind: row.kind,
    createdAtMs: row.created_at_ms,
    read: row.read === 1,
  };
}

function rawToFile(row: RawFileRow): FileRecord {
  return {
    id: row.id,
    ownerHandle: row.owner_handle,
    filename: row.filename,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    relativePath: row.relative_path,
    createdAtMs: row.created_at_ms,
  };
}
