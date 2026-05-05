/**
 * Public surface of the operator process.
 *
 * Exports the entrypoint function that `src/operator/main.ts` calls when
 * the file is run directly. Tests import {@link runOperatorMain} for
 * white-box assertions; production code never calls into here, only
 * `main.ts` does.
 */
import { OperatorConfigError, operatorConfigFromEnv } from "./config.js";
import { startOperatorServer, type OperatorHandle } from "./server.js";
import {
  openOperatorDatabase,
  smokeCheckSqliteBinding,
} from "./storage/database.js";
import { OperatorRepository } from "./storage/repository.js";

export { type OperatorHandle } from "./server.js";

/**
 * Read config from env, start the HTTP server, and install signal handlers.
 *
 * Returns once the server is listening; the function is "fire and forget" —
 * the spawned process stays alive on the open server and exits via the
 * signal handlers (SIGTERM / SIGINT). Errors during startup terminate the
 * process with a non-zero exit code so the parent supervisor sees them
 * via the spawned child's exit event.
 *
 * Startup ordering matters: validate the SQLite binding *before* binding
 * any port. A subtle source of pain is leaving a port held by an operator
 * that crashed mid-startup — the supervisor then sees "did not become
 * healthy" without knowing why. The smoke check below ensures the
 * native binding loads (or the process dies before listening) so that
 * failure mode can never silently leak a port.
 */
export async function runOperatorMain(): Promise<void> {
  let handle: OperatorHandle;
  let db: ReturnType<typeof openOperatorDatabase> | null = null;
  try {
    smokeCheckSqliteBinding();
    const config = operatorConfigFromEnv();
    db = openOperatorDatabase(config.databasePath);
    const repo = new OperatorRepository(db);
    handle = await startOperatorServer({ config, db, repo });
    // One-line readiness log — the supervision layer doesn't grep this,
    // it polls /healthz. The line is purely for humans tailing the log
    // file, so format it that way.
    process.stdout.write(
      `robotnet-operator: network=${config.networkName} version=${config.operatorVersion} listening on http://${handle.host}:${handle.port}\n`,
    );
  } catch (err) {
    if (db !== null) db.close();
    if (err instanceof OperatorConfigError) {
      process.stderr.write(`robotnet-operator: config error: ${err.message}\n`);
      process.exit(2);
    }
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(`robotnet-operator: failed to start: ${detail}\n`);
    process.exit(1);
  }

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`robotnet-operator: received ${signal}, shutting down\n`);
    handle
      .close()
      .then(() => {
        if (db !== null) db.close();
        process.exit(0);
      })
      .catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err);
        process.stderr.write(`robotnet-operator: shutdown error: ${detail}\n`);
        process.exit(1);
      });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
