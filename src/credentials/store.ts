import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import { RobotNetCLIError } from "../errors.js";
import { UnsafePlaintextEncryptor, type Encryptor } from "./crypto.js";
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from "./schema.js";

export type AgentCredentialKind =
  | "local_bearer"
  | "oauth_pkce"
  | "oauth_client_credentials";

export type UserSessionAuthMode = "pkce" | "client_credentials";

/** Full user-session record, including the decrypted secrets. */
export interface UserSessionRecord {
  readonly accessToken: string;
  readonly idToken: string | null;
  readonly refreshToken: string | null;
  readonly accessTokenExpiresAt: number | null;
  readonly idTokenExpiresAt: number | null;
  readonly scope: string | null;
  readonly clientId: string | null;
  readonly tokenEndpoint: string;
  readonly resource: string | null;
  readonly redirectUri: string | null;
  readonly authMode: UserSessionAuthMode;
  readonly updatedAt: number;
}

/** Non-secret subset returned to diagnostic callers (doctor, `login show`). */
export interface UserSessionInfo {
  readonly clientId: string | null;
  readonly scope: string | null;
  readonly tokenEndpoint: string;
  readonly resource: string | null;
  readonly redirectUri: string | null;
  readonly authMode: UserSessionAuthMode;
  readonly accessTokenExpiresAt: number | null;
  readonly updatedAt: number;
}

export interface UserSessionInput {
  readonly accessToken: string;
  readonly idToken?: string | null;
  readonly refreshToken?: string | null;
  readonly accessTokenExpiresAt?: number | null;
  readonly idTokenExpiresAt?: number | null;
  readonly scope?: string | null;
  readonly clientId?: string | null;
  readonly tokenEndpoint: string;
  readonly resource?: string | null;
  readonly redirectUri?: string | null;
  readonly authMode: UserSessionAuthMode;
}

export interface AdminTokenRecord {
  readonly networkName: string;
  readonly token: string;
  readonly issuedAt: number;
  readonly updatedAt: number;
}

export interface AgentCredentialRecord {
  readonly networkName: string;
  readonly handle: string;
  readonly kind: AgentCredentialKind;
  readonly bearer: string;
  readonly bearerExpiresAt: number | null;
  readonly refreshToken: string | null;
  readonly clientId: string | null;
  readonly clientSecret: string | null;
  readonly scope: string | null;
  readonly registeredAt: number;
  readonly updatedAt: number;
}

/** Subset of {@link AgentCredentialRecord} needed to insert or update a row. */
export interface AgentCredentialInput {
  readonly networkName: string;
  readonly handle: string;
  readonly kind: AgentCredentialKind;
  readonly bearer: string;
  readonly bearerExpiresAt?: number | null;
  readonly refreshToken?: string | null;
  readonly clientId?: string | null;
  readonly clientSecret?: string | null;
  readonly scope?: string | null;
}

export class CredentialStoreError extends RobotNetCLIError {
  constructor(message: string) {
    super(message);
    this.name = "CredentialStoreError";
  }
}

/**
 * SQLite-backed credential store, shared with the RobotNet desktop app.
 *
 * The DB file is opened in WAL mode so multiple processes (the CLI and the
 * Mac app) can read concurrently with one writer at a time. Every secret
 * column passes through {@link Encryptor.encrypt} on write and
 * {@link Encryptor.decrypt} on read; today the only implementation is
 * {@link UnsafePlaintextEncryptor}, with a Keychain-backed implementation
 * planned (see `crypto.ts`).
 *
 * The store does NOT clean up after itself — call {@link close} when done.
 * The CLI's command actions are short-lived, so opening at the start of
 * an action and closing at the end is the expected lifecycle.
 */
export class CredentialStore {
  readonly #db: Database.Database;
  readonly #encryptor: Encryptor;

  /**
   * Open the DB at `path`, creating the file (and parent directory) if it
   * does not exist, and applying any pending schema migrations.
   *
   * The file is forced to mode `0600` after creation; on POSIX this means
   * "owner read/write only" — the only filesystem-level protection for the
   * plaintext encryptor.
   */
  static open(path: string, opts: { readonly encryptor?: Encryptor } = {}): CredentialStore {
    mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path);
    try {
      // Tighten permissions before any data lands. On Windows this is a no-op.
      try {
        chmodSync(path, 0o600);
      } catch {
        // best-effort
      }
      db.pragma("journal_mode = WAL");
      db.pragma("foreign_keys = ON");
      // Wait up to 3s on a contended writer before erroring; the Mac app
      // may be holding the lock briefly during a token rotation.
      db.pragma("busy_timeout = 3000");

      runMigrations(db);
    } catch (err) {
      db.close();
      throw err;
    }
    return new CredentialStore(db, opts.encryptor ?? new UnsafePlaintextEncryptor());
  }

  private constructor(db: Database.Database, encryptor: Encryptor) {
    this.#db = db;
    this.#encryptor = encryptor;
  }

  close(): void {
    this.#db.close();
  }

  /** The schema version this DB is currently on. */
  get schemaVersion(): number {
    const row = this.#db
      .prepare("SELECT version FROM schema_version LIMIT 1")
      .get() as { version: number } | undefined;
    return row?.version ?? 0;
  }

  // ── admin tokens ──────────────────────────────────────────────────────────

  getAdminToken(networkName: string): AdminTokenRecord | null {
    const row = this.#db
      .prepare(
        `SELECT network_name, token_ciphertext, issued_at, updated_at
         FROM admin_tokens WHERE network_name = ?`,
      )
      .get(networkName) as
      | { network_name: string; token_ciphertext: Buffer; issued_at: number; updated_at: number }
      | undefined;
    if (!row) return null;
    return {
      networkName: row.network_name,
      token: this.#encryptor.decrypt(row.token_ciphertext),
      issuedAt: row.issued_at,
      updatedAt: row.updated_at,
    };
  }

  putAdminToken(networkName: string, token: string, opts: { readonly issuedAt?: number } = {}): void {
    const now = Date.now();
    const issuedAt = opts.issuedAt ?? now;
    const ct = this.#encryptor.encrypt(token);
    this.#db
      .prepare(
        `INSERT INTO admin_tokens (network_name, token_ciphertext, issued_at, updated_at)
         VALUES (@network_name, @token_ciphertext, @issued_at, @updated_at)
         ON CONFLICT(network_name) DO UPDATE SET
           token_ciphertext = excluded.token_ciphertext,
           issued_at = excluded.issued_at,
           updated_at = excluded.updated_at`,
      )
      .run({
        network_name: networkName,
        token_ciphertext: ct,
        issued_at: issuedAt,
        updated_at: now,
      });
  }

  deleteAdminToken(networkName: string): boolean {
    const info = this.#db
      .prepare("DELETE FROM admin_tokens WHERE network_name = ?")
      .run(networkName);
    return info.changes > 0;
  }

  // ── agent credentials ─────────────────────────────────────────────────────

  getAgentCredential(networkName: string, handle: string): AgentCredentialRecord | null {
    const row = this.#db
      .prepare(
        `SELECT * FROM agent_credentials WHERE network_name = ? AND handle = ?`,
      )
      .get(networkName, handle) as RawAgentRow | undefined;
    if (!row) return null;
    return rowToAgent(row, this.#encryptor);
  }

  /**
   * List handles registered on `networkName`. Returns the full records so the
   * caller can also see kind/expiry without N+1 lookups.
   */
  listAgentCredentials(networkName: string): readonly AgentCredentialRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM agent_credentials WHERE network_name = ? ORDER BY handle`,
      )
      .all(networkName) as RawAgentRow[];
    return rows.map((r) => rowToAgent(r, this.#encryptor));
  }

  putAgentCredential(input: AgentCredentialInput): void {
    validateInput(input);
    const now = Date.now();
    const bearerCt = this.#encryptor.encrypt(input.bearer);
    const refreshCt =
      input.refreshToken != null ? this.#encryptor.encrypt(input.refreshToken) : null;
    const clientSecretCt =
      input.clientSecret != null ? this.#encryptor.encrypt(input.clientSecret) : null;

    this.#db
      .prepare(
        `INSERT INTO agent_credentials (
           network_name, handle, kind,
           bearer_ciphertext, bearer_expires_at,
           refresh_token_ciphertext, client_id, client_secret_ciphertext,
           scope, registered_at, updated_at
         ) VALUES (
           @network_name, @handle, @kind,
           @bearer_ciphertext, @bearer_expires_at,
           @refresh_token_ciphertext, @client_id, @client_secret_ciphertext,
           @scope, @registered_at, @updated_at
         )
         ON CONFLICT(network_name, handle) DO UPDATE SET
           kind = excluded.kind,
           bearer_ciphertext = excluded.bearer_ciphertext,
           bearer_expires_at = excluded.bearer_expires_at,
           refresh_token_ciphertext = excluded.refresh_token_ciphertext,
           client_id = excluded.client_id,
           client_secret_ciphertext = excluded.client_secret_ciphertext,
           scope = excluded.scope,
           updated_at = excluded.updated_at`,
      )
      .run({
        network_name: input.networkName,
        handle: input.handle,
        kind: input.kind,
        bearer_ciphertext: bearerCt,
        bearer_expires_at: input.bearerExpiresAt ?? null,
        refresh_token_ciphertext: refreshCt,
        client_id: input.clientId ?? null,
        client_secret_ciphertext: clientSecretCt,
        scope: input.scope ?? null,
        registered_at: now,
        updated_at: now,
      });
  }

  deleteAgentCredential(networkName: string, handle: string): boolean {
    const info = this.#db
      .prepare(
        `DELETE FROM agent_credentials WHERE network_name = ? AND handle = ?`,
      )
      .run(networkName, handle);
    return info.changes > 0;
  }

  // ── user session (singleton) ──────────────────────────────────────────────

  /** Existence check for the user session — does not decrypt anything. */
  hasUserSession(): boolean {
    const row = this.#db
      .prepare("SELECT 1 AS one FROM user_sessions WHERE id = 1")
      .get() as { one: number } | undefined;
    return row !== undefined;
  }

  /** Non-secret subset of the user session, suitable for diagnostics. */
  getUserSessionInfo(): UserSessionInfo | null {
    const row = this.#db
      .prepare(
        `SELECT client_id, scope, token_endpoint, resource, redirect_uri,
                auth_mode, access_token_expires_at, updated_at
         FROM user_sessions WHERE id = 1`,
      )
      .get() as
      | {
          client_id: string | null;
          scope: string | null;
          token_endpoint: string;
          resource: string | null;
          redirect_uri: string | null;
          auth_mode: UserSessionAuthMode;
          access_token_expires_at: number | null;
          updated_at: number;
        }
      | undefined;
    if (!row) return null;
    return {
      clientId: row.client_id,
      scope: row.scope,
      tokenEndpoint: row.token_endpoint,
      resource: row.resource,
      redirectUri: row.redirect_uri,
      authMode: row.auth_mode,
      accessTokenExpiresAt: row.access_token_expires_at,
      updatedAt: row.updated_at,
    };
  }

  getUserSession(): UserSessionRecord | null {
    const row = this.#db
      .prepare("SELECT * FROM user_sessions WHERE id = 1")
      .get() as RawUserSessionRow | undefined;
    if (!row) return null;
    return rowToUserSession(row, this.#encryptor);
  }

  putUserSession(input: UserSessionInput): void {
    const now = Date.now();
    const accessCt = this.#encryptor.encrypt(input.accessToken);
    const idCt =
      input.idToken != null && input.idToken.length > 0
        ? this.#encryptor.encrypt(input.idToken)
        : null;
    const refreshCt =
      input.refreshToken != null && input.refreshToken.length > 0
        ? this.#encryptor.encrypt(input.refreshToken)
        : null;

    this.#db
      .prepare(
        `INSERT INTO user_sessions (
           id,
           access_token_ciphertext, id_token_ciphertext, refresh_token_ciphertext,
           access_token_expires_at, id_token_expires_at,
           scope, client_id, token_endpoint, resource, redirect_uri,
           auth_mode, updated_at
         ) VALUES (
           1,
           @access_token_ciphertext, @id_token_ciphertext, @refresh_token_ciphertext,
           @access_token_expires_at, @id_token_expires_at,
           @scope, @client_id, @token_endpoint, @resource, @redirect_uri,
           @auth_mode, @updated_at
         )
         ON CONFLICT(id) DO UPDATE SET
           access_token_ciphertext = excluded.access_token_ciphertext,
           id_token_ciphertext = excluded.id_token_ciphertext,
           refresh_token_ciphertext = excluded.refresh_token_ciphertext,
           access_token_expires_at = excluded.access_token_expires_at,
           id_token_expires_at = excluded.id_token_expires_at,
           scope = excluded.scope,
           client_id = excluded.client_id,
           token_endpoint = excluded.token_endpoint,
           resource = excluded.resource,
           redirect_uri = excluded.redirect_uri,
           auth_mode = excluded.auth_mode,
           updated_at = excluded.updated_at`,
      )
      .run({
        access_token_ciphertext: accessCt,
        id_token_ciphertext: idCt,
        refresh_token_ciphertext: refreshCt,
        access_token_expires_at: input.accessTokenExpiresAt ?? null,
        id_token_expires_at: input.idTokenExpiresAt ?? null,
        scope: input.scope ?? null,
        client_id: input.clientId ?? null,
        token_endpoint: input.tokenEndpoint,
        resource: input.resource ?? null,
        redirect_uri: input.redirectUri ?? null,
        auth_mode: input.authMode,
        updated_at: now,
      });
  }

  deleteUserSession(): boolean {
    const info = this.#db.prepare("DELETE FROM user_sessions WHERE id = 1").run();
    return info.changes > 0;
  }

  // ── counts (for diagnostics; secrets-free) ────────────────────────────────

  countAdminTokens(): number {
    const row = this.#db
      .prepare("SELECT count(*) AS n FROM admin_tokens")
      .get() as { n: number };
    return row.n;
  }

  countAgentCredentials(): number {
    const row = this.#db
      .prepare("SELECT count(*) AS n FROM agent_credentials")
      .get() as { n: number };
    return row.n;
  }

  // ── recovery from a key change (e.g. OS keychain reset) ───────────────────

  /**
   * Walk every secret-bearing row and delete the ones whose ciphertext fails
   * to decrypt. Returns the per-table counts so callers can report what was
   * cleaned up.
   *
   * Triggered automatically by `auth-resolver` when a read throws
   * {@link CredentialDecryptionError} — a key change typically invalidates
   * every row at once, so a sweep is cheaper than handling them one-by-one.
   */
  purgeUnreadableRows(): {
    readonly adminTokens: number;
    readonly agentCredentials: number;
    readonly userSessions: number;
  } {
    const badAdmin: string[] = [];
    const adminRows = this.#db
      .prepare("SELECT network_name, token_ciphertext FROM admin_tokens")
      .all() as Array<{ network_name: string; token_ciphertext: Buffer }>;
    for (const r of adminRows) {
      if (!this.#canDecrypt(r.token_ciphertext)) badAdmin.push(r.network_name);
    }
    const adminDelete = this.#db.prepare(
      "DELETE FROM admin_tokens WHERE network_name = ?",
    );
    for (const name of badAdmin) adminDelete.run(name);

    const badAgent: Array<{ network: string; handle: string }> = [];
    const agentRows = this.#db
      .prepare(
        `SELECT network_name, handle,
                bearer_ciphertext,
                refresh_token_ciphertext,
                client_secret_ciphertext
         FROM agent_credentials`,
      )
      .all() as Array<{
        network_name: string;
        handle: string;
        bearer_ciphertext: Buffer;
        refresh_token_ciphertext: Buffer | null;
        client_secret_ciphertext: Buffer | null;
      }>;
    for (const r of agentRows) {
      if (
        !this.#canDecrypt(r.bearer_ciphertext) ||
        (r.refresh_token_ciphertext !== null &&
          !this.#canDecrypt(r.refresh_token_ciphertext)) ||
        (r.client_secret_ciphertext !== null &&
          !this.#canDecrypt(r.client_secret_ciphertext))
      ) {
        badAgent.push({ network: r.network_name, handle: r.handle });
      }
    }
    const agentDelete = this.#db.prepare(
      "DELETE FROM agent_credentials WHERE network_name = ? AND handle = ?",
    );
    for (const r of badAgent) agentDelete.run(r.network, r.handle);

    let userSessionsPurged = 0;
    const userRow = this.#db
      .prepare(
        `SELECT access_token_ciphertext, id_token_ciphertext, refresh_token_ciphertext
         FROM user_sessions WHERE id = 1`,
      )
      .get() as
      | {
          access_token_ciphertext: Buffer;
          id_token_ciphertext: Buffer | null;
          refresh_token_ciphertext: Buffer | null;
        }
      | undefined;
    if (userRow !== undefined) {
      if (
        !this.#canDecrypt(userRow.access_token_ciphertext) ||
        (userRow.id_token_ciphertext !== null &&
          !this.#canDecrypt(userRow.id_token_ciphertext)) ||
        (userRow.refresh_token_ciphertext !== null &&
          !this.#canDecrypt(userRow.refresh_token_ciphertext))
      ) {
        this.#db.prepare("DELETE FROM user_sessions WHERE id = 1").run();
        userSessionsPurged = 1;
      }
    }

    return {
      adminTokens: badAdmin.length,
      agentCredentials: badAgent.length,
      userSessions: userSessionsPurged,
    };
  }

  #canDecrypt(blob: Buffer): boolean {
    try {
      this.#encryptor.decrypt(blob);
      return true;
    } catch {
      return false;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Internal helpers                                                            */
/* -------------------------------------------------------------------------- */

interface RawAgentRow {
  network_name: string;
  handle: string;
  kind: AgentCredentialKind;
  bearer_ciphertext: Buffer;
  bearer_expires_at: number | null;
  refresh_token_ciphertext: Buffer | null;
  client_id: string | null;
  client_secret_ciphertext: Buffer | null;
  scope: string | null;
  registered_at: number;
  updated_at: number;
}

interface RawUserSessionRow {
  access_token_ciphertext: Buffer;
  id_token_ciphertext: Buffer | null;
  refresh_token_ciphertext: Buffer | null;
  access_token_expires_at: number | null;
  id_token_expires_at: number | null;
  scope: string | null;
  client_id: string | null;
  token_endpoint: string;
  resource: string | null;
  redirect_uri: string | null;
  auth_mode: UserSessionAuthMode;
  updated_at: number;
}

function rowToUserSession(row: RawUserSessionRow, enc: Encryptor): UserSessionRecord {
  return {
    accessToken: enc.decrypt(row.access_token_ciphertext),
    idToken: row.id_token_ciphertext ? enc.decrypt(row.id_token_ciphertext) : null,
    refreshToken: row.refresh_token_ciphertext
      ? enc.decrypt(row.refresh_token_ciphertext)
      : null,
    accessTokenExpiresAt: row.access_token_expires_at,
    idTokenExpiresAt: row.id_token_expires_at,
    scope: row.scope,
    clientId: row.client_id,
    tokenEndpoint: row.token_endpoint,
    resource: row.resource,
    redirectUri: row.redirect_uri,
    authMode: row.auth_mode,
    updatedAt: row.updated_at,
  };
}

function rowToAgent(row: RawAgentRow, enc: Encryptor): AgentCredentialRecord {
  return {
    networkName: row.network_name,
    handle: row.handle,
    kind: row.kind,
    bearer: enc.decrypt(row.bearer_ciphertext),
    bearerExpiresAt: row.bearer_expires_at,
    refreshToken: row.refresh_token_ciphertext
      ? enc.decrypt(row.refresh_token_ciphertext)
      : null,
    clientId: row.client_id,
    clientSecret: row.client_secret_ciphertext
      ? enc.decrypt(row.client_secret_ciphertext)
      : null,
    scope: row.scope,
    registeredAt: row.registered_at,
    updatedAt: row.updated_at,
  };
}

function validateInput(input: AgentCredentialInput): void {
  switch (input.kind) {
    case "local_bearer":
      if (input.refreshToken != null || input.clientId != null || input.clientSecret != null) {
        throw new CredentialStoreError(
          "local_bearer credentials must not carry oauth fields (refresh_token, client_id, client_secret)",
        );
      }
      return;
    case "oauth_pkce":
      if (input.clientSecret != null) {
        throw new CredentialStoreError(
          "oauth_pkce credentials are public — must not carry client_secret",
        );
      }
      if (input.clientId == null) {
        throw new CredentialStoreError(
          "oauth_pkce credentials must carry the public client_id used at /authorize " +
            "time so refresh-token renewal can replay against the same client",
        );
      }
      return;
    case "oauth_client_credentials":
      if (input.refreshToken != null) {
        throw new CredentialStoreError(
          "oauth_client_credentials credentials do not have a refresh_token",
        );
      }
      if (input.clientId == null || input.clientSecret == null) {
        throw new CredentialStoreError(
          "oauth_client_credentials requires both client_id and client_secret",
        );
      }
      return;
    default: {
      // Exhaustiveness check — adding a new AgentCredentialKind triggers
      // a TS error here until the new case is handled above.
      const _exhaustive: never = input.kind;
      throw new CredentialStoreError(`unhandled credential kind: ${String(_exhaustive)}`);
    }
  }
}

function runMigrations(db: Database.Database): void {
  // schema_version may not exist on a brand-new DB. Detect via sqlite_master.
  const tableRow = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'",
    )
    .get() as { name: string } | undefined;
  const currentVersion = tableRow
    ? ((db.prepare("SELECT version FROM schema_version LIMIT 1").get() as
        | { version: number }
        | undefined)?.version ?? 0)
    : 0;

  for (const migration of MIGRATIONS) {
    if (migration.version <= currentVersion) continue;
    db.exec("BEGIN");
    try {
      db.exec(migration.sql);
      // First migration creates schema_version *with* an inserted row, so
      // subsequent migrations need to UPDATE rather than INSERT.
      if (migration.version > 1) {
        db.prepare("UPDATE schema_version SET version = ?").run(migration.version);
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  // Sanity: reject DBs that are *newer* than this binary knows about.
  const finalVersion = (db
    .prepare("SELECT version FROM schema_version LIMIT 1")
    .get() as { version: number } | undefined)?.version ?? 0;
  if (finalVersion > CURRENT_SCHEMA_VERSION) {
    throw new CredentialStoreError(
      `credential store schema version ${finalVersion} is newer than this CLI supports (${CURRENT_SCHEMA_VERSION}). ` +
        `Upgrade the CLI.`,
    );
  }
}
