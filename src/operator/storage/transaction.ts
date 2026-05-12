import type { DatabaseSync } from "node:sqlite";

/**
 * Run `fn` inside a SQLite transaction, committing on success and rolling
 * back on throw. Returns whatever `fn` returns.
 *
 * `node:sqlite` does not provide better-sqlite3's `db.transaction(fn)`
 * wrapper, so the operator's domain layer composes atomicity through this
 * helper. `BEGIN` defaults to `BEGIN DEFERRED`, matching better-sqlite3's
 * behavior — the writer lock is acquired only when the first write runs,
 * and `PRAGMA busy_timeout` (set at open time) absorbs brief contention.
 *
 * Nested calls are not supported; callers must not invoke this from inside
 * another `withTransaction` on the same connection. Use SQLite SAVEPOINTs
 * directly if nesting is ever needed.
 */
export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // best-effort: a failed rollback (e.g. connection already closed)
      // must not mask the original error.
    }
    throw err;
  }
}
