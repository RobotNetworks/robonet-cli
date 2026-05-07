import type Database from "better-sqlite3";

import type {
  AgentRecord,
  AllowlistEntry,
  BlockRecord,
  DeliveryCursorRecord,
  EventRecord,
  Handle,
  IdempotencyRecord,
  InboundPolicy,
  MessageRecord,
  ParticipantRecord,
  ParticipantStatus,
  Sequence,
  SessionId,
  SessionRecord,
  SessionState,
} from "./types.js";

/* -------------------------------------------------------------------------- */
/* Repository facade                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Bundle of typed accessors over the operator's SQLite database. The
 * service layer composes these inside `db.transaction(...)` blocks; the
 * repos themselves don't open transactions so the caller controls
 * atomicity boundaries.
 *
 * Construction is cheap — repos hold prepared statements but no
 * mutable state — so a single instance per operator process is fine.
 */
export class OperatorRepository {
  readonly agents: AgentsRepo;
  readonly blocks: BlocksRepo;
  readonly sessions: SessionsRepo;
  readonly participants: ParticipantsRepo;
  readonly messages: MessagesRepo;
  readonly events: EventsRepo;
  readonly cursors: DeliveryCursorsRepo;
  readonly idempotency: IdempotencyRepo;

  constructor(db: Database.Database) {
    this.agents = new AgentsRepo(db);
    this.blocks = new BlocksRepo(db);
    this.sessions = new SessionsRepo(db);
    this.participants = new ParticipantsRepo(db);
    this.messages = new MessagesRepo(db);
    this.events = new EventsRepo(db);
    this.cursors = new DeliveryCursorsRepo(db);
    this.idempotency = new IdempotencyRepo(db);
  }
}

/* -------------------------------------------------------------------------- */
/* Agents + allowlist                                                          */
/* -------------------------------------------------------------------------- */

export interface RegisterAgentInput {
  readonly handle: Handle;
  readonly bearerTokenHash: string;
  readonly inboundPolicy?: InboundPolicy;
  readonly metadata?: Readonly<Record<string, unknown>> | null;
}

export class AgentsRepo {
  readonly #db: Database.Database;

  constructor(db: Database.Database) {
    this.#db = db;
  }

  register(input: RegisterAgentInput): AgentRecord {
    const now = Date.now();
    const policy = input.inboundPolicy ?? "allowlist";
    const metadataJson =
      input.metadata !== undefined && input.metadata !== null
        ? JSON.stringify(input.metadata)
        : null;
    this.#db
      .prepare(
        `INSERT INTO agents (handle, bearer_token_hash, inbound_policy, metadata_json, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(input.handle, input.bearerTokenHash, policy, metadataJson, now, now);
    const got = this.byHandle(input.handle);
    if (got === null) {
      throw new Error(
        `internal: agent ${input.handle} disappeared immediately after insert`,
      );
    }
    return got;
  }

  byHandle(handle: Handle): AgentRecord | null {
    const row = this.#db
      .prepare("SELECT * FROM agents WHERE handle = ?")
      .get(handle) as RawAgentRow | undefined;
    return row === undefined ? null : rawToAgent(row);
  }

  byBearerHash(hash: string): AgentRecord | null {
    const row = this.#db
      .prepare("SELECT * FROM agents WHERE bearer_token_hash = ?")
      .get(hash) as RawAgentRow | undefined;
    return row === undefined ? null : rawToAgent(row);
  }

  list(): readonly AgentRecord[] {
    const rows = this.#db
      .prepare("SELECT * FROM agents ORDER BY handle")
      .all() as RawAgentRow[];
    return rows.map(rawToAgent);
  }

  remove(handle: Handle): boolean {
    return (
      this.#db.prepare("DELETE FROM agents WHERE handle = ?").run(handle).changes > 0
    );
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
      .get(ownerHandle, entry) as RawAllowlistRow | undefined;
    if (got === undefined) {
      throw new Error(`internal: allowlist row missing after upsert (${ownerHandle}, ${entry})`);
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
      .all(ownerHandle) as RawAllowlistRow[];
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
  readonly #db: Database.Database;

  constructor(db: Database.Database) {
    this.#db = db;
  }

  /**
   * Idempotently record `blockerHandle` blocking `blockedHandle`. Re-issuing
   * the same block is a no-op for the row but the returned record reflects
   * the *original* `created_at_ms` so callers see a stable timestamp.
   */
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
      .get(blockerHandle, blockedHandle) as RawBlockRow | undefined;
    if (got === undefined) {
      throw new Error(
        `internal: block row missing after upsert (${blockerHandle} → ${blockedHandle})`,
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

  list(blockerHandle: Handle, opts: { readonly limit?: number; readonly offset?: number } = {}): readonly BlockRecord[] {
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;
    const rows = this.#db
      .prepare(
        `SELECT * FROM blocks
         WHERE blocker_handle = ?
         ORDER BY created_at_ms DESC, blocked_handle ASC
         LIMIT ? OFFSET ?`,
      )
      .all(blockerHandle, limit, offset) as RawBlockRow[];
    return rows.map(rawToBlock);
  }

  /** True iff `blockerHandle` is blocking `blockedHandle`. Used by session eligibility checks. */
  isBlocking(blockerHandle: Handle, blockedHandle: Handle): boolean {
    return (
      this.#db
        .prepare(
          `SELECT 1 FROM blocks WHERE blocker_handle = ? AND blocked_handle = ? LIMIT 1`,
        )
        .get(blockerHandle, blockedHandle) !== undefined
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Sessions                                                                    */
/* -------------------------------------------------------------------------- */

export interface CreateSessionInput {
  readonly id: SessionId;
  readonly creatorHandle: Handle;
  readonly topic?: string | null;
}

export class SessionsRepo {
  readonly #db: Database.Database;

  constructor(db: Database.Database) {
    this.#db = db;
  }

  create(input: CreateSessionInput): SessionRecord {
    const now = Date.now();
    this.#db
      .prepare(
        `INSERT INTO sessions (id, creator_handle, state, topic, created_at_ms, updated_at_ms)
         VALUES (?, ?, 'active', ?, ?, ?)`,
      )
      .run(input.id, input.creatorHandle, input.topic ?? null, now, now);
    // Initialise the per-session sequence counter so events can claim
    // sequences without an extra round-trip on first append.
    this.#db
      .prepare(
        "INSERT INTO session_sequences (session_id, next_sequence) VALUES (?, 1)",
      )
      .run(input.id);
    const got = this.byId(input.id);
    if (got === null) {
      throw new Error(`internal: session ${input.id} missing after insert`);
    }
    return got;
  }

  byId(id: SessionId): SessionRecord | null {
    const row = this.#db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(id) as RawSessionRow | undefined;
    return row === undefined ? null : rawToSession(row);
  }

  /**
   * Sessions where `handle` is a participant (any status), most-recently-
   * updated first. Used by `GET /sessions` to surface an agent's full
   * session list. Distinct on session id so multi-status rows don't double
   * up.
   */
  listForHandle(handle: Handle): readonly SessionRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT DISTINCT s.*
           FROM sessions s
           INNER JOIN participants p ON p.session_id = s.id
          WHERE p.handle = ?
          ORDER BY s.updated_at_ms DESC, s.id DESC`,
      )
      .all(handle) as RawSessionRow[];
    return rows.map(rawToSession);
  }

  setState(id: SessionId, state: SessionState): boolean {
    const now = Date.now();
    return (
      this.#db
        .prepare(
          `UPDATE sessions
             SET state = ?,
                 updated_at_ms = ?,
                 ended_at_ms = CASE
                   WHEN ? = 'ended'  THEN COALESCE(ended_at_ms, ?)
                   WHEN ? = 'active' THEN NULL
                   ELSE ended_at_ms
                 END
           WHERE id = ?`,
        )
        .run(state, now, state, now, state, id).changes > 0
    );
  }

  /**
   * Allocate the next sequence number for the session and advance the
   * counter atomically. Throws if the session does not exist.
   *
   * Must be called inside a transaction so the read-and-increment is
   * serialised against concurrent writers — better-sqlite3's deferred
   * transactions provide that guarantee on the writer.
   */
  allocateSequence(id: SessionId): Sequence {
    const row = this.#db
      .prepare(
        "SELECT next_sequence FROM session_sequences WHERE session_id = ?",
      )
      .get(id) as { next_sequence: number } | undefined;
    if (row === undefined) {
      throw new Error(`internal: missing session_sequences row for ${id}`);
    }
    const seq = row.next_sequence;
    this.#db
      .prepare(
        "UPDATE session_sequences SET next_sequence = next_sequence + 1 WHERE session_id = ?",
      )
      .run(id);
    return seq;
  }
}

/* -------------------------------------------------------------------------- */
/* Participants                                                                */
/* -------------------------------------------------------------------------- */

export class ParticipantsRepo {
  readonly #db: Database.Database;

  constructor(db: Database.Database) {
    this.#db = db;
  }

  add(sessionId: SessionId, handle: Handle, status: ParticipantStatus): ParticipantRecord {
    const now = Date.now();
    const joinedAt = status === "joined" ? now : null;
    const leftAt = status === "left" ? now : null;
    this.#db
      .prepare(
        `INSERT INTO participants (session_id, handle, status, joined_at_ms, left_at_ms)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(sessionId, handle, status, joinedAt, leftAt);
    const got = this.get(sessionId, handle);
    if (got === null) {
      throw new Error(`internal: participant ${sessionId}/${handle} missing after insert`);
    }
    return got;
  }

  setStatus(sessionId: SessionId, handle: Handle, status: ParticipantStatus): boolean {
    const now = Date.now();
    return (
      this.#db
        .prepare(
          `UPDATE participants
             SET status = ?,
                 joined_at_ms = CASE WHEN ? = 'joined' THEN COALESCE(joined_at_ms, ?) ELSE joined_at_ms END,
                 left_at_ms   = CASE WHEN ? = 'left'   THEN ? ELSE left_at_ms END
           WHERE session_id = ? AND handle = ?`,
        )
        .run(status, status, now, status, now, sessionId, handle).changes > 0
    );
  }

  get(sessionId: SessionId, handle: Handle): ParticipantRecord | null {
    const row = this.#db
      .prepare(
        "SELECT * FROM participants WHERE session_id = ? AND handle = ?",
      )
      .get(sessionId, handle) as RawParticipantRow | undefined;
    return row === undefined ? null : rawToParticipant(row);
  }

  listForSession(sessionId: SessionId): readonly ParticipantRecord[] {
    const rows = this.#db
      .prepare("SELECT * FROM participants WHERE session_id = ? ORDER BY handle")
      .all(sessionId) as RawParticipantRow[];
    return rows.map(rawToParticipant);
  }

  listForHandle(handle: Handle): readonly ParticipantRecord[] {
    const rows = this.#db
      .prepare("SELECT * FROM participants WHERE handle = ?")
      .all(handle) as RawParticipantRow[];
    return rows.map(rawToParticipant);
  }
}

/* -------------------------------------------------------------------------- */
/* Messages                                                                    */
/* -------------------------------------------------------------------------- */

export interface InsertMessageInput {
  readonly id: string;
  readonly sessionId: SessionId;
  readonly senderHandle: Handle;
  readonly sequence: Sequence;
  readonly content: unknown;
  readonly idempotencyKey?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>> | null;
}

export class MessagesRepo {
  readonly #db: Database.Database;

  constructor(db: Database.Database) {
    this.#db = db;
  }

  insert(input: InsertMessageInput): MessageRecord {
    const now = Date.now();
    const metadataJson =
      input.metadata !== undefined && input.metadata !== null
        ? JSON.stringify(input.metadata)
        : null;
    this.#db
      .prepare(
        `INSERT INTO messages
           (id, session_id, sender_handle, sequence, content_json, idempotency_key, metadata_json, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.sessionId,
        input.senderHandle,
        input.sequence,
        JSON.stringify(input.content),
        input.idempotencyKey ?? null,
        metadataJson,
        now,
      );
    const got = this.byId(input.id);
    if (got === null) {
      throw new Error(`internal: message ${input.id} missing after insert`);
    }
    return got;
  }

  byId(id: string): MessageRecord | null {
    const row = this.#db
      .prepare("SELECT * FROM messages WHERE id = ?")
      .get(id) as RawMessageRow | undefined;
    return row === undefined ? null : rawToMessage(row);
  }

  /**
   * Substring search over messages the caller could have seen.
   *
   * Eligibility: the caller must currently be a `joined` participant on the
   * session, and the message must have been sent at or after they joined.
   * That mirrors the eligibility envelope that history replay applies — a
   * caller who has `left` no longer sees new searches; an `invited` caller
   * has nothing to find yet.
   *
   * Optional filters:
   * - `sessionId` narrows to a single session.
   * - `counterpartHandle` narrows to sessions that also have the given peer
   *   as a participant (any status), supporting "what did I say to X".
   *
   * The query parameter is treated as a literal substring — `%`, `_`, and
   * `\\` are escaped before the LIKE wrap so callers searching for those
   * characters get what they typed. Results ordered most-recent first.
   */
  searchForCaller(args: {
    readonly callerHandle: Handle;
    readonly query: string;
    readonly limit: number;
    readonly sessionId?: SessionId;
    readonly counterpartHandle?: Handle;
  }): readonly MessageRecord[] {
    const escaped = args.query.replace(/[\\%_]/g, (c) => `\\${c}`);
    const like = `%${escaped}%`;

    const filters: string[] = [];
    const params: unknown[] = [args.callerHandle, like];
    if (args.sessionId !== undefined) {
      filters.push("AND m.session_id = ?");
      params.push(args.sessionId);
    }
    if (args.counterpartHandle !== undefined) {
      filters.push(
        "AND EXISTS (SELECT 1 FROM participants pp WHERE pp.session_id = m.session_id AND pp.handle = ?)",
      );
      params.push(args.counterpartHandle);
    }
    params.push(args.limit);

    const sql = `
      SELECT m.*
        FROM messages m
        INNER JOIN participants p ON p.session_id = m.session_id
       WHERE p.handle = ?
         AND p.status = 'joined'
         AND p.joined_at_ms IS NOT NULL
         AND m.created_at_ms >= p.joined_at_ms
         AND m.content_json LIKE ? ESCAPE '\\'
         ${filters.join("\n         ")}
       ORDER BY m.created_at_ms DESC, m.id DESC
       LIMIT ?
    `;
    const rows = this.#db.prepare(sql).all(...params) as RawMessageRow[];
    return rows.map(rawToMessage);
  }
}

/* -------------------------------------------------------------------------- */
/* Events                                                                      */
/* -------------------------------------------------------------------------- */

export interface AppendEventInput {
  readonly id: string;
  readonly sessionId: SessionId;
  readonly sequence: Sequence;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export class EventsRepo {
  readonly #db: Database.Database;

  constructor(db: Database.Database) {
    this.#db = db;
  }

  append(input: AppendEventInput): EventRecord {
    const now = Date.now();
    this.#db
      .prepare(
        `INSERT INTO events (id, session_id, sequence, type, payload_json, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.sessionId,
        input.sequence,
        input.type,
        JSON.stringify(input.payload),
        now,
      );
    const got = this.byId(input.id);
    if (got === null) {
      throw new Error(`internal: event ${input.id} missing after insert`);
    }
    return got;
  }

  byId(id: string): EventRecord | null {
    const row = this.#db
      .prepare("SELECT * FROM events WHERE id = ?")
      .get(id) as RawEventRow | undefined;
    return row === undefined ? null : rawToEvent(row);
  }

  /** Read events for a session past `afterSequence` (exclusive), in order, up to `limit` rows. */
  listForSessionAfter(
    sessionId: SessionId,
    afterSequence: Sequence,
    limit: number,
  ): readonly EventRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM events
         WHERE session_id = ? AND sequence > ?
         ORDER BY sequence
         LIMIT ?`,
      )
      .all(sessionId, afterSequence, limit) as RawEventRow[];
    return rows.map(rawToEvent);
  }
}

/* -------------------------------------------------------------------------- */
/* Delivery cursors                                                            */
/* -------------------------------------------------------------------------- */

export class DeliveryCursorsRepo {
  readonly #db: Database.Database;

  constructor(db: Database.Database) {
    this.#db = db;
  }

  /** Returns 0 when no cursor row exists (i.e. no events have been delivered to this handle for this session). */
  get(handle: Handle, sessionId: SessionId): Sequence {
    const row = this.#db
      .prepare(
        "SELECT last_delivered_sequence FROM delivery_cursors WHERE handle = ? AND session_id = ?",
      )
      .get(handle, sessionId) as { last_delivered_sequence: number } | undefined;
    return row?.last_delivered_sequence ?? 0;
  }

  /** Idempotent — only advances when `sequence` strictly exceeds the stored cursor. */
  advance(handle: Handle, sessionId: SessionId, sequence: Sequence): void {
    this.#db
      .prepare(
        `INSERT INTO delivery_cursors (handle, session_id, last_delivered_sequence)
         VALUES (?, ?, ?)
         ON CONFLICT (handle, session_id) DO UPDATE SET
           last_delivered_sequence = MAX(excluded.last_delivered_sequence, last_delivered_sequence)`,
      )
      .run(handle, sessionId, sequence);
  }

  listForHandle(handle: Handle): readonly DeliveryCursorRecord[] {
    const rows = this.#db
      .prepare("SELECT * FROM delivery_cursors WHERE handle = ?")
      .all(handle) as RawCursorRow[];
    return rows.map(rawToCursor);
  }
}

/* -------------------------------------------------------------------------- */
/* Idempotency                                                                 */
/* -------------------------------------------------------------------------- */

export interface InsertIdempotencyInput {
  readonly sessionId: SessionId;
  readonly senderHandle: Handle;
  readonly key: string;
  readonly messageId: string;
  readonly sequence: Sequence;
}

export class IdempotencyRepo {
  readonly #db: Database.Database;

  constructor(db: Database.Database) {
    this.#db = db;
  }

  lookup(
    sessionId: SessionId,
    senderHandle: Handle,
    key: string,
  ): IdempotencyRecord | null {
    const row = this.#db
      .prepare(
        `SELECT * FROM idempotency
         WHERE session_id = ? AND sender_handle = ? AND key = ?`,
      )
      .get(sessionId, senderHandle, key) as RawIdempotencyRow | undefined;
    return row === undefined ? null : rawToIdempotency(row);
  }

  record(input: InsertIdempotencyInput): IdempotencyRecord {
    const now = Date.now();
    this.#db
      .prepare(
        `INSERT INTO idempotency (session_id, sender_handle, key, message_id, sequence, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.sessionId,
        input.senderHandle,
        input.key,
        input.messageId,
        input.sequence,
        now,
      );
    const got = this.lookup(input.sessionId, input.senderHandle, input.key);
    if (got === null) {
      throw new Error(
        `internal: idempotency row missing after insert (${input.sessionId}/${input.senderHandle}/${input.key})`,
      );
    }
    return got;
  }
}

/* -------------------------------------------------------------------------- */
/* Raw row → domain mappers                                                    */
/* -------------------------------------------------------------------------- */

interface RawAgentRow {
  handle: string;
  bearer_token_hash: string;
  inbound_policy: InboundPolicy;
  metadata_json: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

interface RawAllowlistRow {
  owner_handle: string;
  entry: string;
  created_at_ms: number;
}

interface RawSessionRow {
  id: string;
  creator_handle: string;
  state: SessionState;
  topic: string | null;
  created_at_ms: number;
  updated_at_ms: number;
  ended_at_ms: number | null;
}

interface RawParticipantRow {
  session_id: string;
  handle: string;
  status: ParticipantStatus;
  joined_at_ms: number | null;
  left_at_ms: number | null;
}

interface RawMessageRow {
  id: string;
  session_id: string;
  sender_handle: string;
  sequence: number;
  content_json: string;
  idempotency_key: string | null;
  metadata_json: string | null;
  created_at_ms: number;
}

interface RawEventRow {
  id: string;
  session_id: string;
  sequence: number;
  type: string;
  payload_json: string;
  created_at_ms: number;
}

interface RawCursorRow {
  handle: string;
  session_id: string;
  last_delivered_sequence: number;
}

interface RawIdempotencyRow {
  session_id: string;
  sender_handle: string;
  key: string;
  message_id: string;
  sequence: number;
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

function rawToAgent(row: RawAgentRow): AgentRecord {
  return {
    handle: row.handle,
    bearerTokenHash: row.bearer_token_hash,
    inboundPolicy: row.inbound_policy,
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

function rawToSession(row: RawSessionRow): SessionRecord {
  return {
    id: row.id,
    creatorHandle: row.creator_handle,
    state: row.state,
    topic: row.topic,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    endedAtMs: row.ended_at_ms,
  };
}

function rawToParticipant(row: RawParticipantRow): ParticipantRecord {
  return {
    sessionId: row.session_id,
    handle: row.handle,
    status: row.status,
    joinedAtMs: row.joined_at_ms,
    leftAtMs: row.left_at_ms,
  };
}

function rawToMessage(row: RawMessageRow): MessageRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    senderHandle: row.sender_handle,
    sequence: row.sequence,
    content: JSON.parse(row.content_json) as unknown,
    idempotencyKey: row.idempotency_key,
    metadata: parseOptionalJsonObject(row.metadata_json),
    createdAtMs: row.created_at_ms,
  };
}

function rawToEvent(row: RawEventRow): EventRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    sequence: row.sequence,
    type: row.type,
    payload: parseJsonObject(row.payload_json),
    createdAtMs: row.created_at_ms,
  };
}

function rawToCursor(row: RawCursorRow): DeliveryCursorRecord {
  return {
    handle: row.handle,
    sessionId: row.session_id,
    lastDeliveredSequence: row.last_delivered_sequence,
  };
}

function rawToIdempotency(row: RawIdempotencyRow): IdempotencyRecord {
  return {
    sessionId: row.session_id,
    senderHandle: row.sender_handle,
    key: row.key,
    messageId: row.message_id,
    sequence: row.sequence,
    createdAtMs: row.created_at_ms,
  };
}
