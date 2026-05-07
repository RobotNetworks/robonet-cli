/**
 * SQLite schema for the local credential store.
 *
 * Mirrors the shape of the eventual remote ASP postgres tables — same primary
 * keys, same column meaning — so a future migration is mechanical. The rest
 * (account_id columns, user_sessions, etc.) lands when those concepts arrive.
 *
 * Migrations are forward-only and idempotent. Each entry is a transaction
 * the store applies if `schema_version.version` is below it.
 */

export const CURRENT_SCHEMA_VERSION = 3;

interface Migration {
  readonly version: number;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE schema_version (
        version INTEGER NOT NULL
      );
      INSERT INTO schema_version (version) VALUES (1);

      -- Local admin tokens — one per local network the user runs.
      -- Single row per network; written by 'robotnet network start' and
      -- read by the network-management commands ('network reset', the
      -- unified 'agent' group when the resolved network is local).
      CREATE TABLE admin_tokens (
        network_name TEXT NOT NULL PRIMARY KEY,
        token_ciphertext BLOB NOT NULL,
        issued_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- Per-agent credentials, keyed by (network_name, handle).
      -- 'kind' selects which renewal columns are populated:
      --   local_bearer              → no renewal; bearer never expires
      --   oauth_pkce                → refresh via refresh_token
      --   oauth_client_credentials  → refresh via client_id + client_secret
      CREATE TABLE agent_credentials (
        network_name TEXT NOT NULL,
        handle TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN (
          'local_bearer',
          'oauth_pkce',
          'oauth_client_credentials'
        )),
        bearer_ciphertext BLOB NOT NULL,
        bearer_expires_at INTEGER,             -- null for local_bearer
        refresh_token_ciphertext BLOB,         -- oauth_pkce only
        client_id TEXT,                        -- oauth_client_credentials only
        client_secret_ciphertext BLOB,         -- oauth_client_credentials only
        scope TEXT,
        registered_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (network_name, handle)
      );

      CREATE INDEX agent_credentials_by_network
        ON agent_credentials (network_name);
    `,
  },
  {
    version: 2,
    sql: `
      -- The human user's authenticated session for this profile.
      -- Singleton — one user per profile (the CLI's --profile flag isolates).
      -- When remote account-backed credentials land, account_id can join.
      CREATE TABLE user_sessions (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        access_token_ciphertext BLOB NOT NULL,
        id_token_ciphertext BLOB,
        refresh_token_ciphertext BLOB,
        access_token_expires_at INTEGER,
        id_token_expires_at INTEGER,
        scope TEXT,
        client_id TEXT,
        token_endpoint TEXT NOT NULL,
        resource TEXT,
        redirect_uri TEXT,
        auth_mode TEXT NOT NULL CHECK (auth_mode IN ('pkce', 'client_credentials')),
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 3,
    sql: `
      -- The built-in remote network was renamed from "robotnet" to "public"
      -- so the network name reflects role (public vs. local) rather than
      -- branding. Move any existing credentials forward so testers who
      -- already logged in keep working without re-authenticating.
      --
      -- The same row swap is safe to apply unconditionally: only callers who
      -- intentionally created a "robotnet" network in their profile config
      -- could have rows under that key, and the rename matches the new
      -- builtin name they would have used after the upgrade. If a user
      -- *also* defined a "public" network (collision), this UPDATE would
      -- fail the (network_name, handle) primary key — INSERT-OR-IGNORE
      -- semantics aren't worth the complexity for a pre-prod release.
      UPDATE admin_tokens SET network_name = 'public' WHERE network_name = 'robotnet';
      UPDATE agent_credentials SET network_name = 'public' WHERE network_name = 'robotnet';
    `,
  },
];
