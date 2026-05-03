import { Command } from "commander";

import { resolveSessionClient } from "../asp/auth-resolver.js";
import { handleArg } from "../asp/handles.js";
import { startReconnectingAspListener } from "../asp/reconnecting-listener.js";
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
 * (so consumers piping into `jq -c` or similar see the event stream cleanly).
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
        const { config, identity } = await loadConfigForAgentCommand(cmd, opts.as);

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
            process.stderr.write(`robotnet: WebSocket error: ${err.message}\n`);
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
          ...(opts.maxAttempts !== undefined ? { maxAttempts: opts.maxAttempts } : {}),
        });

        process.on("SIGINT", () => {
          listener.close();
          process.exit(0);
        });
      }),
  );
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
