import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from "./schema.js";

export class OperatorDatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperatorDatabaseError";
  }
}

/**
 * Open an in-memory SQLite database, run a trivial query, and close it.
 *
 * Used as a startup-time smoke check by the operator entrypoint: if
 * `better-sqlite3`'s native binding is missing or built for the wrong
 * Node ABI, this throws synchronously before any port is bound. That
 * matters because the operator's failure mode is supposed to be
 * fail-fast — a bound port without a working SQLite store leaves the
 * supervisor stuck on a `/healthz` poll that will never succeed and
 * (worse) the parent's only signal is "did not become healthy."
 */
export function smokeCheckSqliteBinding(): void {
  const db = new Database(":memory:");
  try {
    db.prepare("SELECT 1").get();
  } finally {
    db.close();
  }
}

/**
 * Open (and migrate) the operator's SQLite file at `path`.
 *
 * Settings: WAL journaling so concurrent readers don't block the writer,
 * `foreign_keys = ON` so the cascade-delete contracts on agents/sessions
 * are enforced, and a 3s `busy_timeout` to absorb brief lock contention.
 *
 * The file is forced to mode 0600 immediately after creation. On Windows
 * this is a no-op.
 */
export function openOperatorDatabase(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    try {
      chmodSync(path, 0o600);
    } catch {
      // best-effort
    }
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 3000");

    runMigrations(db);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

/** Read the current schema version. Returns 0 for a brand-new DB. */
export function readSchemaVersion(db: Database.Database): number {
  const tableRow = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'",
    )
    .get() as { name: string } | undefined;
  if (tableRow === undefined) return 0;
  const row = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string } | undefined;
  if (row === undefined) return 0;
  const n = Number.parseInt(row.value, 10);
  if (!Number.isInteger(n) || n < 0) {
    throw new OperatorDatabaseError(
      `meta.schema_version is not a non-negative integer: ${JSON.stringify(row.value)}`,
    );
  }
  return n;
}

function runMigrations(db: Database.Database): void {
  let currentVersion = readSchemaVersion(db);

  for (const migration of MIGRATIONS) {
    if (migration.version <= currentVersion) continue;
    db.exec("BEGIN");
    try {
      db.exec(migration.sql);
      // First migration creates `meta` and inserts schema_version=1.
      // Subsequent migrations bump it via UPDATE.
      if (migration.version > 1) {
        db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'")
          .run(String(migration.version));
      }
      db.exec("COMMIT");
      currentVersion = migration.version;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  // Reject DBs that are *newer* than this binary knows about.
  const finalVersion = readSchemaVersion(db);
  if (finalVersion > CURRENT_SCHEMA_VERSION) {
    throw new OperatorDatabaseError(
      `operator database schema version ${finalVersion} is newer than this CLI supports (${CURRENT_SCHEMA_VERSION}). Upgrade the CLI.`,
    );
  }
}
