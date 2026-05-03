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

export const CURRENT_SCHEMA_VERSION = 2;

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

      -- Admin tokens for networks the user can administer.
      -- Single row per network; written by the desktop app's network
      -- supervisor and by 'robotnet agent register' (admin token override).
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
      -- When the remote ASP postgres lands, account_id (Cognito sub) will join.
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
];
