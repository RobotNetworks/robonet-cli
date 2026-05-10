import type Database from "better-sqlite3";

import type {
  AgentRecord,
  AgentVisibility,
  AllowlistEntry,
  BlockRecord,
  DeliveryCursorRecord,
  EventRecord,
  FileRecord,
  FileStatus,
  Handle,
  IdempotencyRecord,
  InboundPolicy,
  MessageId,
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
  readonly files: FilesRepo;

  constructor(db: Database.Database) {
    this.agents = new AgentsRepo(db);
    this.blocks = new BlocksRepo(db);
    this.sessions = new SessionsRepo(db);
    this.participants = new ParticipantsRepo(db);
    this.messages = new MessagesRepo(db);
    this.events = new EventsRepo(db);
    this.cursors = new DeliveryCursorsRepo(db);
    this.idempotency = new IdempotencyRepo(db);
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
  readonly #db: Database.Database;

  constructor(db: Database.Database) {
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

  /**
   * Apply a partial profile update to an existing agent. Returns the
   * updated record, or `null` if no agent exists with that handle.
   *
   * Each field is independently optional: omitting a field leaves the
   * stored value untouched. Passing `null` for `description` or
   * `cardBody` clears it. `displayName` cannot be cleared (the wire
   * shape requires a non-null display name; clearing would force the
   * read path to fall back to the handle, which is what register does
   * by default anyway).
   */
  updateProfile(
    handle: Handle,
    input: UpdateAgentProfileInput,
  ): AgentRecord | null {
    const sets: string[] = [];
    const params: unknown[] = [];
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

  /**
   * Substring search across `handle` and `display_name`. Case-insensitive
   * via SQLite's `LIKE` (which is ASCII case-insensitive by default; for
   * names with non-ASCII characters callers can match exact prefixes or
   * fall back to the search service on the hosted operator).
   *
   * Returns `limit + 1` rows is intentionally not done — the caller
   * paginates externally if needed. Visibility filtering happens in the
   * route layer because it depends on caller identity.
   */
  search(query: string, limit: number): readonly AgentRecord[] {
    return this.searchPage({ query, limit });
  }

  /**
   * Cursor-paginated agent search.
   *
   * Sort key is the agent `handle` (already unique). The cursor — passed
   * back from the prior response's `next_cursor` — is the handle of the
   * last row from that page; rows with a strictly greater handle make
   * up the next page. Visibility filtering happens in the route layer
   * because it depends on the caller's identity, so a short page does
   * NOT mean end-of-results — clients should keep paging while
   * `next_cursor` is non-null.
   */
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
      .all(pattern, pattern, after, args.limit) as RawAgentRow[];
    return rows.map(rawToAgent);
  }

  /**
   * Remove an agent and all rows that reference it.
   *
   * The schema cascades from `agents(handle)` for allowlist and blocks
   * but NOT for `sessions(creator_handle)`, so a naive `DELETE FROM
   * agents` raises a foreign-key error whenever the agent has ever
   * created a session. Cascade through the dependent rows explicitly:
   *
   *   1. Sessions the agent created — cascade chains down to
   *      participants, messages, events, delivery_cursors,
   *      session_sequences, idempotency via their `sessions(id)` FKs.
   *   2. Participant rows where the agent is a member of someone
   *      else's session (no FK from `participants.handle` to agents).
   *   3. Delivery cursors keyed on the agent's handle (no FK).
   *   4. The agent row itself.
   *
   * Wrapped in a transaction so a partial failure rolls back. Returns
   * true iff the agent existed.
   */
  remove(handle: Handle): boolean {
    const txn = this.#db.transaction((h: Handle) => {
      this.#db.prepare("DELETE FROM sessions WHERE creator_handle = ?").run(h);
      this.#db.prepare("DELETE FROM participants WHERE handle = ?").run(h);
      this.#db.prepare("DELETE FROM delivery_cursors WHERE handle = ?").run(h);
      return this.#db.prepare("DELETE FROM agents WHERE handle = ?").run(h).changes;
    });
    return (txn(handle) as number) > 0;
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

  /**
   * Reset a participant to `invited` and clear `joined_at_ms` / `left_at_ms`
   * — used by `reopenSession` so that the wire view of a re-invited prior
   * participant doesn't carry the stale `joined_at` from before the end.
   * `setStatus` deliberately preserves those timestamps; this is the only
   * codepath that explicitly rewinds them.
   */
  reinvite(sessionId: SessionId, handle: Handle): boolean {
    return (
      this.#db
        .prepare(
          `UPDATE participants
             SET status = 'invited',
                 joined_at_ms = NULL,
                 left_at_ms = NULL
           WHERE session_id = ? AND handle = ?`,
        )
        .run(sessionId, handle).changes > 0
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
/* Files                                                                       */
/* -------------------------------------------------------------------------- */

export interface RegisterFileInput {
  readonly id: string;
  readonly uploaderHandle: Handle;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly relativePath: string;
  /** Pending TTL — when ``null``, the row is created already-attached
   *  (not used today; reserved for inline create-and-claim flows). */
  readonly expiresAtMs: number | null;
}

export class FilesRepo {
  readonly #db: Database.Database;

  constructor(db: Database.Database) {
    this.#db = db;
  }

  register(input: RegisterFileInput): FileRecord {
    const now = Date.now();
    this.#db
      .prepare(
        `INSERT INTO files (
          id, status, session_message_id, uploader_handle,
          filename, content_type, size_bytes, relative_path,
          created_at_ms, expires_at_ms
        ) VALUES (?, 'pending', NULL, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.uploaderHandle,
        input.filename,
        input.contentType,
        input.sizeBytes,
        input.relativePath,
        now,
        input.expiresAtMs,
      );
    const got = this.byId(input.id);
    if (got === null) {
      throw new Error(`internal: file row missing after insert (${input.id})`);
    }
    return got;
  }

  /** Look up a row by id without ownership check. Used by the download
   *  route after the eligibility check (caller is a session participant
   *  on the message that owns this file). */
  byId(id: string): FileRecord | null {
    const row = this.#db
      .prepare("SELECT * FROM files WHERE id = ?")
      .get(id) as RawFileRow | undefined;
    return row === undefined ? null : rawToFile(row);
  }

  /** Fetch a pending row only if owned by ``uploaderHandle``. The
   *  ownership check is the non-enumeration boundary for the upload
   *  → claim flow: callers can't probe other agents' uploads. */
  pendingForUploader(id: string, uploaderHandle: Handle): FileRecord | null {
    const row = this.#db
      .prepare(
        `SELECT * FROM files
         WHERE id = ? AND uploader_handle = ? AND status = 'pending'`,
      )
      .get(id, uploaderHandle) as RawFileRow | undefined;
    return row === undefined ? null : rawToFile(row);
  }

  /** Flip ``pending`` → ``attached`` for the given ids, only when each
   *  is still owned by ``uploaderHandle`` and pending. Returns the
   *  count of rows actually claimed. */
  claimMany(
    ids: readonly string[],
    sessionMessageId: MessageId,
    uploaderHandle: Handle,
  ): number {
    if (ids.length === 0) return 0;
    const stmt = this.#db.prepare(
      `UPDATE files
         SET status = 'attached',
             session_message_id = ?,
             expires_at_ms = NULL
       WHERE id = ?
         AND uploader_handle = ?
         AND status = 'pending'`,
    );
    let count = 0;
    for (const id of ids) {
      const result = stmt.run(sessionMessageId, id, uploaderHandle);
      count += result.changes;
    }
    return count;
  }

  /** Returns the rows that should be deleted from disk + DB by the
   *  background sweeper. */
  expiredPending(now: number): readonly FileRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM files
         WHERE status = 'pending' AND expires_at_ms IS NOT NULL AND expires_at_ms < ?`,
      )
      .all(now) as RawFileRow[];
    return rows.map(rawToFile);
  }

  /** Delete a pending row by id; returns true if a row was removed. */
  removePending(id: string): boolean {
    const result = this.#db
      .prepare("DELETE FROM files WHERE id = ? AND status = 'pending'")
      .run(id);
    return result.changes > 0;
  }
}

/* -------------------------------------------------------------------------- */
/* Raw row → domain mappers                                                    */
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

interface RawFileRow {
  id: string;
  status: FileStatus;
  session_message_id: string | null;
  uploader_handle: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  relative_path: string;
  created_at_ms: number;
  expires_at_ms: number | null;
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

/**
 * Escape `%` and `_` so they're treated as literals in a `LIKE` pattern.
 * Backslash itself is escaped first; the `ESCAPE '\\'` clause in the
 * caller's prepared statement honors the escape sequence.
 */
function escapeLike(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/[%_]/g, "\\$&");
}

function rawToAgent(row: RawAgentRow): AgentRecord {
  return {
    handle: row.handle,
    bearerTokenHash: row.bearer_token_hash,
    inboundPolicy: row.inbound_policy,
    // Backfilled by migration v3 to row.handle, but a column-default-less
    // row could still be NULL on a hand-edited DB; fall back to the handle
    // so the wire shape never carries a null display_name.
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

function rawToFile(row: RawFileRow): FileRecord {
  return {
    id: row.id,
    status: row.status,
    sessionMessageId: row.session_message_id,
    uploaderHandle: row.uploader_handle,
    filename: row.filename,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    relativePath: row.relative_path,
    createdAtMs: row.created_at_ms,
    expiresAtMs: row.expires_at_ms,
  };
}
