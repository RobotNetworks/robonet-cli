import { Command } from "commander";

import { resolveSessionClient } from "../asp/auth-resolver.js";
import { handleArg } from "../asp/handles.js";
import {
  startReconnectingAspListener,
  type TerminalFailure,
} from "../asp/reconnecting-listener.js";
import { RobotNetCLIError } from "../errors.js";
import { loadConfigForAgentCommand, out } from "./asp-shared.js";

/**
 * `robotnet listen` — stream the agent's session events over WebSocket.
 *
 * Connects to the network's `/connect` endpoint, prints each inbound event
 * as one JSON line on stdout, and survives transient drops via exponential
 * backoff + jitter. Auth-resolver re-mints OAuth bearers on each reconnect
 * so a long-running listener picks up renewed credentials transparently.
 *
 * Exits 0 on Ctrl-C. Reconnect noise goes to stderr; events go to stdout
 * so consumers piping into `jq -c` or similar see the event stream cleanly.
 *
 * On terminal failure (permanent auth/credential error, or `--max-attempts`
 * exhausted) the listener writes one final summary line to stdout — prefixed
 * `[robotnet] terminating: …` — and exits 1. The stdout summary exists so
 * supervisors that only see stdout (e.g. Claude Code's Monitor tool) get the
 * reason for the exit, not just "process exited."
 */
export function registerListenCommand(program: Command): void {
  program.addCommand(
    new Command("listen")
      .description(
        "Stream live session events for an agent over WebSocket (Ctrl-C to stop)",
      )
      .option("--as <handle>", "Act as this agent handle", handleArg)
      .option(
        "--token <token>",
        "Override the stored agent bearer token (escape hatch)",
      )
      .option(
        "--max-attempts <n>",
        "Cap on reconnect attempts. Default: unbounded.",
        parsePositiveIntArg,
      )
      .action(async (opts: ListenOpts, cmd: Command) => {
        // Catch the pre-flight throw (e.g. "no agent specified") so the
        // terminating-stdout-summary contract holds for early failures too,
        // not just for runtime ones surfaced via onTerminalFailure. The
        // re-throw lets the top-level handler still write its stderr line
        // and set exit code 1.
        let resolved: Awaited<ReturnType<typeof loadConfigForAgentCommand>>;
        try {
          resolved = await loadConfigForAgentCommand(cmd, opts.as);
        } catch (err) {
          if (err instanceof RobotNetCLIError) {
            writeTerminating(err.message);
          }
          throw err;
        }
        const { config, identity } = resolved;

        process.stderr.write(
          `Listening for events on ${config.network.name} as ${identity.handle}…\n`,
        );

        const listener = startReconnectingAspListener({
          resolve: async () => {
            // Re-resolve on every connect attempt so the auth-resolver can
            // hand back a freshly-minted bearer if the cached one expired.
            const client = await resolveSessionClient(
              config,
              identity.handle,
              opts.token,
            );
            return { wsUrl: client.wsUrl, token: client.token };
          },
          onEvent: (_event, raw) => out(raw),
          onUnparseable: (raw) => {
            process.stderr.write(`robotnet: dropped unparseable frame: ${raw}\n`);
          },
          onError: (err) => {
            process.stderr.write(`robotnet: ${err.message}\n`);
          },
          onClose: (code, reason) => {
            const tail = reason.length > 0 ? `: ${reason}` : "";
            process.stderr.write(`robotnet: connection closed (${code}${tail})\n`);
          },
          onReconnectScheduled: (attempt, delayMs) => {
            const seconds = (delayMs / 1000).toFixed(1);
            process.stderr.write(
              `robotnet: reconnecting in ${seconds}s (attempt ${attempt})\n`,
            );
          },
          onTerminalFailure: (failure) => {
            writeTerminating(formatTerminalFailure(failure));
            // Exit immediately rather than letting the event loop drain:
            // any pending I/O would otherwise delay the supervisor's
            // exit-code notification past the point where it's useful.
            process.exit(1);
          },
          ...(opts.maxAttempts !== undefined ? { maxAttempts: opts.maxAttempts } : {}),
        });

        process.on("SIGINT", () => {
          listener.close();
          process.exit(0);
        });
      }),
  );
}

/**
 * Write the standardized terminating-summary line to stdout. The stdout
 * channel matters: it's the only stream Claude Code's Monitor tool surfaces
 * as a notification, so this is what tells a model-driven supervisor *why*
 * the listener stopped. Terminal-style consumers see it interleaved with
 * any stderr noise and read it the same way.
 */
function writeTerminating(reason: string): void {
  out(`[robotnet] terminating: ${reason}`);
}

function formatTerminalFailure(failure: TerminalFailure): string {
  switch (failure.reason) {
    case "permanent_resolve_error":
      return failure.error.message;
    case "max_attempts_exhausted":
      return (
        `gave up after ${failure.attempts} reconnect attempts ` +
        `(last error: ${failure.error.message})`
      );
  }
}

interface ListenOpts {
  readonly as?: string;
  readonly token?: string;
  readonly maxAttempts?: number;
}

function parsePositiveIntArg(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1 || String(n) !== raw.trim()) {
    throw new Error(`expected a positive integer, got "${raw}"`);
  }
  return n;
}
