/**
 * SQLite schema for the in-tree local operator's persistent state.
 *
 * Lives at `<dataDir>/networks/<name>/operator.sqlite`. Holds agents,
 * allowlist entries, blocks, envelopes, per-recipient mailbox entries,
 * and file metadata.
 *
 * Notes on the design:
 *
 * - Bearer tokens are stored as sha256 hashes (no plaintext at rest). The
 *   plaintext is returned exactly once at registration time and never
 *   recoverable; admins rotate to issue a new one.
 * - One envelope row plus one mailbox_entries row per recipient. The
 *   envelope id is the spec ULID; the mailbox PK is `(mailbox_handle,
 *   envelope_id)`; the keyset index is `(mailbox_handle, created_at,
 *   envelope_id)` so pagination is a tight range scan in either order.
 * - Foreign keys are declared and `PRAGMA foreign_keys = ON` is set in
 *   the database wrapper. Cascading deletes are intentional: dropping an
 *   agent walks the allowlist + blocks + mailbox + envelopes-they-sent
 *   rows too.
 * - Files are local-disk-backed (the in-tree operator is dev-only). The
 *   `files` table records `(owner_handle, relative_path)` so a network
 *   reset removes both the metadata and the bytes together.
 *
 * Migrations are forward-only and idempotent. Each entry is a transaction
 * the database wrapper applies if `meta.value` for `schema_version` is
 * below the migration's version.
 */

export const CURRENT_SCHEMA_VERSION = 1;

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
      INSERT INTO meta (key, value) VALUES ('schema_version', '1');

      -- ── Agents ────────────────────────────────────────────────────────
      --
      -- One row per registered agent. The bearer token is stored as a
      -- sha256 hash so a DB compromise does not leak credentials. The
      -- plaintext is returned exactly once at registration time.
      --
      -- 'inbound_policy' controls envelope admission: 'open' admits any
      -- sender; 'allowlist' (default) admits only senders matching an
      -- entry in the allowlist table.
      CREATE TABLE agents (
        handle TEXT NOT NULL PRIMARY KEY,
        bearer_token_hash TEXT NOT NULL UNIQUE,
        inbound_policy TEXT NOT NULL CHECK (inbound_policy IN ('open', 'allowlist'))
          DEFAULT 'allowlist',
        display_name TEXT,
        description TEXT,
        card_body TEXT,
        visibility TEXT NOT NULL CHECK (visibility IN ('public', 'private'))
          DEFAULT 'private',
        metadata_json TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );

      -- ── Allowlist ─────────────────────────────────────────────────────
      --
      -- Each row represents one trust grant from owner_handle. The entry
      -- is either a specific handle (@x.y) or an owner glob (@x.*).
      CREATE TABLE allowlist (
        owner_handle TEXT NOT NULL REFERENCES agents(handle) ON DELETE CASCADE,
        entry TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY (owner_handle, entry)
      );

      -- ── Blocks ────────────────────────────────────────────────────────
      --
      -- A unilateral deny: the blocker no longer accepts inbound envelopes
      -- from the blocked agent regardless of policy. blocked_handle is
      -- intentionally NOT a foreign key into agents so pre-emptive blocks
      -- of off-network handles are valid.
      CREATE TABLE blocks (
        blocker_handle TEXT NOT NULL REFERENCES agents(handle) ON DELETE CASCADE,
        blocked_handle TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY (blocker_handle, blocked_handle)
      );

      CREATE INDEX blocks_by_blocked ON blocks (blocked_handle);

      -- ── Envelopes ─────────────────────────────────────────────────────
      --
      -- Canonical envelope record, written once per accepted POST
      -- /messages. from_handle is the operator-stamped sender; client
      -- supplies everything else. body_json is the entire envelope
      -- (content parts and all) serialized verbatim; fetches reconstruct
      -- it directly. received_ms is the operator's accept-time clock;
      -- created_at_ms is the envelope-level total-order timestamp
      -- shared by every recipient copy.
      CREATE TABLE envelopes (
        id TEXT NOT NULL PRIMARY KEY,
        from_handle TEXT NOT NULL REFERENCES agents(handle) ON DELETE CASCADE,
        subject TEXT,
        in_reply_to TEXT,
        date_ms INTEGER NOT NULL,
        received_ms INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL,
        type_hint TEXT NOT NULL CHECK (type_hint IN ('text', 'image', 'file', 'data', 'mixed')),
        size_hint INTEGER,
        monitor_handle TEXT,
        body_json TEXT NOT NULL
      );

      CREATE INDEX envelopes_by_from ON envelopes (from_handle, created_at_ms);

      -- ── Mailbox entries ──────────────────────────────────────────────
      --
      -- One row per recipient of an envelope. Composite key
      -- (mailbox_handle, envelope_id) keeps lookups by-id fast; the
      -- secondary index (mailbox_handle, created_at_ms, envelope_id)
      -- powers the keyset paginator in both asc and desc order.
      --
      -- read defaults false on insert; set true on the first
      -- GET /messages/{id} for that recipient or on POST /mailbox/read.
      CREATE TABLE mailbox_entries (
        mailbox_handle TEXT NOT NULL REFERENCES agents(handle) ON DELETE CASCADE,
        envelope_id TEXT NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('to', 'cc')),
        created_at_ms INTEGER NOT NULL,
        read INTEGER NOT NULL DEFAULT 0 CHECK (read IN (0, 1)),
        PRIMARY KEY (mailbox_handle, envelope_id)
      );

      CREATE INDEX mailbox_entries_by_keyset
        ON mailbox_entries (mailbox_handle, created_at_ms, envelope_id);

      -- ── Files ────────────────────────────────────────────────────────
      --
      -- Upload metadata. Bytes live under the operator's per-network
      -- filesDir (<stateDir>/networks/<name>/files/<id>/<filename>).
      -- Files are uploaded by an agent, returned to the sender as
      -- {file_id, url}, and the sender embeds the URL in a content
      -- part. The download path verifies the bearer can see the file
      -- (currently: any agent that authenticates against this operator
      -- can fetch any file, the local-dev posture, since the in-tree
      -- operator is single-user). The shape leaves room for a stricter
      -- check later without changing the wire surface.
      CREATE TABLE files (
        id TEXT NOT NULL PRIMARY KEY,
        owner_handle TEXT NOT NULL REFERENCES agents(handle) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        relative_path TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      );

      CREATE INDEX files_by_owner ON files (owner_handle);
    `,
  },
];
