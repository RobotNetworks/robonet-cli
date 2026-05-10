/**
 * SQLite schema for the local ASP operator's persistent state.
 *
 * Lives at `<dataDir>/networks/<name>/operator.sqlite`. Holds agents,
 * allowlist entries, sessions, participants, messages, the per-session
 * event log, per-(handle, session) delivery cursors, and idempotency
 * caches.
 *
 * Notes on the design:
 *
 * - Bearer tokens are stored as sha256 hashes (no plaintext at rest). The
 *   plaintext is returned exactly once at registration time and never
 *   recoverable — admin must rotate to issue a new one.
 * - Sequences are monotonic per-session. The next-sequence counter lives
 *   in `session_sequences`, updated transactionally with each event/message
 *   insert so we never hand out duplicate or skipping numbers under
 *   concurrent writes.
 * - Foreign keys are declared and `PRAGMA foreign_keys = ON` is set in
 *   the database wrapper. Cascading deletes are intentional: dropping an
 *   agent (admin op) walks the participant + cursor + idempotency rows
 *   too.
 * - Robot Networks-specific concepts that aren't in ASP itself (e.g. agent cards
 *   and skills, when they land) get added as additional columns on
 *   `agents`, or as sibling tables that FK to `agents.handle`. The schema
 *   was designed to be extended that way without disturbing protocol
 *   tables.
 *
 * Migrations are forward-only and idempotent. Each entry is a transaction
 * the database wrapper applies if `meta.value` for `schema_version` is
 * below the migration's version.
 */

export const CURRENT_SCHEMA_VERSION = 4;

interface Migration {
  readonly version: number;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
      -- Versioned key/value singleton for operator-wide metadata.
      CREATE TABLE meta (
        key TEXT NOT NULL PRIMARY KEY,
        value TEXT NOT NULL
      );
      -- The schema version is itself a meta row so we can evolve other
      -- meta keys (network_name, spec_version, …) without a separate table.
      INSERT INTO meta (key, value) VALUES ('schema_version', '1');

      -- ── Agents ────────────────────────────────────────────────────────
      --
      -- One row per registered agent. The bearer token is stored as a
      -- sha256 hash so a DB compromise does not leak credentials. The
      -- plaintext is returned exactly once at registration time.
      --
      -- 'inbound_policy' controls whether an agent must explicitly trust
      -- a peer to receive sessions from them: 'open' → anyone reachable;
      -- 'allowlist' → only entries in the allowlist table.
      CREATE TABLE agents (
        handle TEXT NOT NULL PRIMARY KEY,
        bearer_token_hash TEXT NOT NULL UNIQUE,
        inbound_policy TEXT NOT NULL CHECK (inbound_policy IN ('open', 'allowlist'))
          DEFAULT 'allowlist',
        metadata_json TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );

      -- ── Allowlist ─────────────────────────────────────────────────────
      --
      -- Each row represents one trust grant from owner_handle. 'entry'
      -- is either a specific handle ("@x.y") or an owner glob ("@x.*").
      CREATE TABLE allowlist (
        owner_handle TEXT NOT NULL REFERENCES agents(handle) ON DELETE CASCADE,
        entry TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY (owner_handle, entry)
      );

      -- ── Sessions ──────────────────────────────────────────────────────
      CREATE TABLE sessions (
        id TEXT NOT NULL PRIMARY KEY,
        creator_handle TEXT NOT NULL REFERENCES agents(handle),
        state TEXT NOT NULL CHECK (state IN ('active', 'ended')),
        topic TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        ended_at_ms INTEGER
      );

      CREATE INDEX sessions_by_creator ON sessions (creator_handle);
      CREATE INDEX sessions_by_state ON sessions (state);

      -- ── Participants ──────────────────────────────────────────────────
      CREATE TABLE participants (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        handle TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('invited', 'joined', 'left')),
        joined_at_ms INTEGER,
        left_at_ms INTEGER,
        PRIMARY KEY (session_id, handle)
      );

      CREATE INDEX participants_by_handle ON participants (handle);

      -- ── Per-session sequence counter ─────────────────────────────────
      --
      -- A separate table so we can UPDATE next_sequence atomically without
      -- scanning the messages / events tables on every write.
      CREATE TABLE session_sequences (
        session_id TEXT NOT NULL PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        next_sequence INTEGER NOT NULL DEFAULT 1
      );

      -- ── Messages ──────────────────────────────────────────────────────
      --
      -- Content lives as raw JSON for flexibility: plain string or array of
      -- typed parts (text/image/file/data). Parsing is the route layer's
      -- job; the store treats it as opaque.
      CREATE TABLE messages (
        id TEXT NOT NULL PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        sender_handle TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        content_json TEXT NOT NULL,
        idempotency_key TEXT,
        metadata_json TEXT,
        created_at_ms INTEGER NOT NULL,
        UNIQUE (session_id, sequence)
      );

      -- ── Events ────────────────────────────────────────────────────────
      --
      -- The per-session event log. Live delivery + replay-since both walk
      -- this table. Eligibility filtering (who is allowed to see what)
      -- happens above this layer at delivery time.
      CREATE TABLE events (
        id TEXT NOT NULL PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        UNIQUE (session_id, sequence)
      );

      CREATE INDEX events_by_session_sequence ON events (session_id, sequence);

      -- ── Delivery cursors ──────────────────────────────────────────────
      --
      -- Per-(handle, session) cursor advancing as events are delivered to
      -- a participant. Replay-since on connect is "events with
      -- session_id in my participations and sequence > cursor".
      CREATE TABLE delivery_cursors (
        handle TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        last_delivered_sequence INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (handle, session_id)
      );

      -- ── Idempotency ───────────────────────────────────────────────────
      --
      -- Per-(session, sender, key) cache so a retry of POST
      -- /sessions/:id/messages with the same key returns the original
      -- (message_id, sequence) instead of re-sending.
      CREATE TABLE idempotency (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        sender_handle TEXT NOT NULL,
        key TEXT NOT NULL,
        message_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY (session_id, sender_handle, key)
      );
    `,
  },
  {
    version: 2,
    sql: `
      -- ── Blocks ────────────────────────────────────────────────────────
      --
      -- Per ASP §6.2, a block is a unilateral deny: the blocker no longer
      -- receives sessions or messages from the blocked agent regardless of
      -- the blocker's allowlist. The blocked side is not enumerated.
      --
      -- 'blocked_handle' is intentionally NOT a foreign key into agents:
      -- a local network may block a handle owned by an agent that doesn't
      -- exist on this operator (the protocol allows pre-emptive blocks),
      -- and tracking off-network handles would still be valid.
      CREATE TABLE blocks (
        blocker_handle TEXT NOT NULL REFERENCES agents(handle) ON DELETE CASCADE,
        blocked_handle TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY (blocker_handle, blocked_handle)
      );

      CREATE INDEX blocks_by_blocked ON blocks (blocked_handle);

      INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '2');
    `,
  },
  {
    version: 3,
    sql: `
      -- ── Agent profile metadata ───────────────────────────────────────
      --
      -- v3 grows the agents row with the profile fields the hosted operator
      -- carries: display_name (defaults to the handle for backfill),
      -- description and card_body (free text), and visibility (controls
      -- whether other agents can discover this one).
      --
      -- 'visibility' is a hard CHECK so the column can't be drifted to
      -- unrecognized values via direct SQL.
      ALTER TABLE agents ADD COLUMN display_name TEXT;
      ALTER TABLE agents ADD COLUMN description TEXT;
      ALTER TABLE agents ADD COLUMN card_body TEXT;
      ALTER TABLE agents ADD COLUMN visibility TEXT
        CHECK (visibility IN ('public', 'private'))
        DEFAULT 'private';

      -- Backfill display_name to the handle so existing rows have
      -- something sensible to render in /agents/me and discovery output.
      UPDATE agents SET display_name = handle WHERE display_name IS NULL;

      -- Visibility on existing rows defaults to 'private' (closed by
      -- default; an admin can promote per-agent via 'admin agent set').
      UPDATE agents SET visibility = 'private' WHERE visibility IS NULL;

      INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '3');
    `,
  },
  {
    version: 4,
    sql: `
      -- ── Files ────────────────────────────────────────────────────────
      --
      -- v4 adds the operator-extension file upload + claim flow that the
      -- production backend already implements. Mirrors the wire shape:
      -- agents POST a file to /files (multipart), get back a file_id,
      -- and reference it from a session message's content
      -- ({type: "file", file_id: "..."}). The session-message path
      -- claims pending files for the message id, and from then on the
      -- file is deliverable to participants via GET /files/:id.
      --
      -- 'relative_path' is relative to the per-network filesDir
      -- (<stateDir>/networks/<name>/files/) so a 'network reset' nukes
      -- both the metadata and the bytes in one shot.
      --
      -- 'pending' files expire after 1h and are reaped by the upload
      -- service on a schedule. 'attached' files have expires_at_ms
      -- cleared and live for the message's lifetime.
      CREATE TABLE files (
        id TEXT NOT NULL PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('pending', 'attached'))
          DEFAULT 'pending',
        session_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        uploader_handle TEXT NOT NULL REFERENCES agents(handle) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        relative_path TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER
      );

      CREATE INDEX files_by_message ON files (session_message_id);
      CREATE INDEX files_by_uploader ON files (uploader_handle);
      CREATE INDEX files_by_pending ON files (status, expires_at_ms);

      INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '4');
    `,
  },
];
