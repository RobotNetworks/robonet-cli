import { Command, Option } from "commander";
import { existsSync, rmSync } from "node:fs";

import { openProcessCredentialStore } from "../credentials/lifecycle.js";
import { RobotNetCLIError } from "../errors.js";
import {
  startNetwork,
  statusNetwork,
  stopNetwork,
} from "../network/lifecycle.js";
import { tailLog } from "../network/logs.js";
import { networkPaths } from "../network/paths.js";
import { renderKeyValues } from "../output/formatters.js";
import { renderJson } from "../output/json-output.js";
import {
  defaultHelpOnBare,
  jsonOption,
  loadConfigFromRoot,
  profileTitle,
} from "./shared.js";

/**
 * `robotnet network ...` — supervise the in-tree local operator.
 *
 * Strictly local: every subcommand calls into `lifecycle.ts`, which gates
 * on {@link assertLocalNetwork} before doing anything. A remote `oauth`
 * network gets a clear error from the gate, not a confusing one further down.
 *
 * Subcommands:
 *
 * - `start` — spawn the operator, wait for `/healthz`, persist the admin
 *   token to the encrypted credential store. Idempotent: if a healthy
 *   operator is already running we adopt it instead of failing.
 * - `stop` — SIGTERM, fall back to SIGKILL after a graceful window.
 * - `status` — render PID, port, uptime, and a live `/healthz` snapshot.
 * - `logs` — `tail [-f]` the operator's stdout/stderr log.
 * - `reset` — destructive: stop the operator, drop the database file, and
 *   delete the local admin token. Confirmation gated by `--yes`.
 */
export function registerNetworkCommand(program: Command): void {
  const network = defaultHelpOnBare(
    new Command("network").description(
      "Supervise the in-tree local operator (start/stop/status/logs/reset)",
    ),
  );

  network
    .command("start")
    .description("Start the in-tree local operator. Idempotent: re-running adopts an already-healthy operator.")
    .addOption(jsonOption())
    .action(async (opts: JsonOpts, cmd: Command) => {
      const config = await loadConfigFromRoot(cmd);
      const result = await startNetwork(config);
      const payload: Record<string, unknown> = {
        adopted: result.adopted,
        network: result.state.network_name,
        url: `http://${result.state.host}:${result.state.port}`,
        pid: result.state.pid,
        operator_version: result.state.operator_version,
        uptime_ms: result.health.uptime_ms,
        log_file: result.state.log_file,
      };
      if (opts.json) {
        console.log(renderJson(payload));
        return;
      }
      const verb = result.adopted ? "Adopted running operator" : "Started local operator";
      const { adopted: _adopted, ...humanPayload } = payload;
      console.log(renderKeyValues(profileTitle(verb, config), humanPayload));
    });

  network
    .command("stop")
    .description("Stop the in-tree local operator (SIGTERM, then SIGKILL after a grace period).")
    .addOption(jsonOption())
    .action(async (opts: JsonOpts, cmd: Command) => {
      const config = await loadConfigFromRoot(cmd);
      const result = await stopNetwork(config);
      const payload = {
        stopped_pid: result.stoppedPid,
        killed: result.killed,
      };
      if (opts.json) {
        console.log(renderJson(payload));
        return;
      }
      const note = result.killed
        ? " (escalated to SIGKILL after grace window)"
        : "";
      console.log(`Stopped local operator (pid ${result.stoppedPid})${note}.`);
    });

  network
    .command("status")
    .description("Show whether the local operator is running, plus a live /healthz snapshot.")
    .addOption(jsonOption())
    .action(async (opts: JsonOpts, cmd: Command) => {
      const config = await loadConfigFromRoot(cmd);
      const result = await statusNetwork(config);
      if (result === null) {
        const payload = { running: false, network: config.network.name };
        if (opts.json) {
          console.log(renderJson(payload));
        } else {
          console.log(
            renderKeyValues(
              profileTitle("Local operator status", config),
              payload,
            ),
          );
        }
        return;
      }
      const uptimeMs = Date.now() - result.state.started_at_ms;
      const payload: Record<string, unknown> = {
        running: true,
        healthy: result.health !== null,
        network: result.state.network_name,
        url: `http://${result.state.host}:${result.state.port}`,
        pid: result.state.pid,
        operator_version: result.state.operator_version,
        uptime_ms: uptimeMs,
        log_file: result.state.log_file,
        database_file: result.state.database_file,
      };
      if (result.health !== null) {
        payload.health_rtt_ms = result.health.rtt_ms;
      }
      if (opts.json) {
        console.log(renderJson(payload));
        return;
      }
      console.log(
        renderKeyValues(profileTitle("Local operator status", config), payload),
      );
    });

  network
    .command("logs")
    .description("Tail the local operator's log file.")
    .option("-f, --follow", "Stream new log lines as they're appended", false)
    .addOption(
      new Option("-n, --lines <count>", "Print the last N lines (default 50)").default(
        "50",
      ),
    )
    .addOption(
      new Option(
        "--tail <count>",
        "Alias for --lines (matches `tail -n` / `kubectl logs --tail`).",
      ),
    )
    .action(async (opts: LogsOpts, cmd: Command) => {
      const config = await loadConfigFromRoot(cmd);
      const paths = networkPaths(config, config.network.name);
      if (!existsSync(paths.logFile)) {
        throw new RobotNetCLIError(
          `No log file at ${paths.logFile}. Has the operator ever been started?`,
        );
      }
      const lines = parseLines(opts.tail ?? opts.lines);
      const ctrl = new AbortController();
      process.once("SIGINT", () => ctrl.abort());
      await tailLog(paths.logFile, {
        follow: opts.follow,
        lines,
        signal: ctrl.signal,
      });
    });

  network
    .command("reset")
    .description(
      "Destructive: stop the operator, delete its database, and clear the local admin token.",
    )
    .option("-y, --yes", "Skip the confirmation prompt", false)
    .action(async (opts: ResetOpts, cmd: Command) => {
      const config = await loadConfigFromRoot(cmd);
      if (!opts.yes) {
        throw new RobotNetCLIError(
          "Refusing to reset without `--yes`. This deletes ALL operator state " +
            "(agents, sessions, allowlist, message history) for this network.",
        );
      }
      const paths = networkPaths(config, config.network.name);

      // Stop if running. Tolerate "not running" — the user may be cleaning
      // up after a crash where state was orphaned.
      try {
        await stopNetwork(config);
      } catch (err) {
        // Only swallow the "not running" case; let other errors (e.g. the
        // network not being local) propagate to the user.
        if (
          !(err instanceof RobotNetCLIError) ||
          err.name !== "NetworkNotRunningError"
        ) {
          throw err;
        }
      }

      if (existsSync(paths.databaseFile)) {
        rmSync(paths.databaseFile, { force: true });
        // SQLite WAL/SHM sidecars are recreated on next open; clean them
        // up too so a stale WAL doesn't replay onto a fresh DB.
        rmSync(`${paths.databaseFile}-wal`, { force: true });
        rmSync(`${paths.databaseFile}-shm`, { force: true });
      }

      const store = await openProcessCredentialStore(config);
      const droppedAdmin = store.deleteLocalAdminToken(config.network.name);
      const droppedAgents = store.deleteAgentCredentialsForNetwork(
        config.network.name,
      );

      // Bearers minted against the just-deleted database are unusable on
      // the next operator boot. Clearing them here means a fresh `admin
      // agent create` mints a new credential into a clean slot, instead
      // of the next `me show` failing with "no stored token" — the foot-
      // gun caught during manual QA.
      const parts: string[] = [
        `Reset network "${config.network.name}".`,
        `Database deleted at ${paths.databaseFile}.`,
        droppedAdmin
          ? "Local admin token cleared."
          : "No local admin token to clear.",
      ];
      if (droppedAgents > 0) {
        parts.push(
          `Cleared ${droppedAgents} stale agent credential${droppedAgents === 1 ? "" : "s"}.`,
        );
      }
      console.log(parts.join(" "));
    });

  program.addCommand(network);
}

interface JsonOpts {
  readonly json?: boolean;
}

interface LogsOpts {
  readonly follow: boolean;
  readonly lines: string;
  readonly tail?: string;
}

interface ResetOpts {
  readonly yes: boolean;
}

function parseLines(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 0 || String(n) !== raw.trim()) {
    throw new RobotNetCLIError(`--lines must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}
