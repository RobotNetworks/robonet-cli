import { Command } from "commander";

import {
  resolveAgentBearer,
  resolveAgentWebsocket,
} from "../asmtp/auth-resolver.js";
import { handleArg } from "../asmtp/handles.js";
import { MailboxClient } from "../asmtp/mailbox-client.js";
import {
  startReconnectingAsmtpListener,
  type TerminalFailure,
} from "../asmtp/reconnecting-listener.js";
import type { PushFrame, ServerFrame, Timestamp } from "../asmtp/types.js";
import {
  advanceWatermark,
  hasSeen,
  loadWatermark,
  saveWatermark,
  watermarkToCursor,
} from "../asmtp/watermark.js";
import type { CLIConfig } from "../config.js";
import { RobotNetCLIError } from "../errors.js";
import { startAgentTerminalIndicator } from "../output/terminal-indicator.js";
import { loadConfigForAgentCommand, out, tokenOption } from "./shared.js";

/**
 * `robotnet listen` — open the network's `/connect` WebSocket and emit
 * each inbound push frame as one JSON line on stdout.
 *
 * Pure server push: the client sends nothing. Reconnects with backoff +
 * jitter; the auth-resolver re-mints expired bearers on each attempt so a
 * long-running listener picks up renewed credentials transparently.
 *
 * On every (re)connect, the listener first runs REST catch-up against
 * `GET /mailbox?order=asc` paginated from the persisted per-identity
 * watermark, advancing the watermark and dedup map as it goes. Live
 * frames are deduped against the same map before being forwarded to
 * stdout. `--no-catch-up` skips REST catch-up; `--watermark <path>`
 * overrides the default watermark location.
 *
 * Exits 0 on Ctrl-C. On terminal failure (permanent auth error or
 * `--max-attempts` exhausted) the listener writes one final summary line
 * to stdout — prefixed `[robotnet] terminating: …` — and exits 1.
 */
export function registerListenCommand(program: Command): void {
  program.addCommand(
    new Command("listen")
      .description(
        "Stream live mailbox push frames over WebSocket (Ctrl-C to stop)",
      )
      .option("--as <handle>", "Act as this agent handle", handleArg)
      .addOption(tokenOption())
      .option(
        "--max-attempts <n>",
        "Cap on reconnect attempts. Default: unbounded.",
        parsePositiveIntArg,
      )
      .option(
        "--no-catch-up",
        "Skip the REST catch-up walk on (re)connect; only emit frames received over WS.",
      )
      .option(
        "--watermark <path>",
        "Override the default per-identity watermark file path.",
      )
      .action(async (opts: ListenOpts, cmd: Command) => {
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
          `Listening on ${config.network.name} as ${identity.handle}\n`,
        );
        const indicator = startAgentTerminalIndicator({
          handle: identity.handle,
          networkName: config.network.name,
        });

        // Track the watermark in-memory across reconnects so each catch-up
        // pass and each live frame advances the same cursor; persist on
        // every advance to survive a crash mid-run.
        let watermark = await loadWatermark(config, identity.handle, opts.watermark);

        const listener = startReconnectingAsmtpListener({
          resolve: async () => {
            const { wsUrl, token } = await resolveAgentWebsocket(
              config,
              identity.handle,
              opts.token,
            );
            return { wsUrl, token };
          },
          onOpen: () => {
            if (opts.catchUp !== false) {
              void runCatchUp({
                config,
                handle: identity.handle,
                token: opts.token,
                getWatermark: () => watermark,
                setWatermark: (w) => {
                  watermark = w;
                },
                watermarkPath: opts.watermark,
                emit: (frame, raw) => {
                  out(raw);
                  return frame;
                },
              }).catch((err: unknown) => {
                const detail = err instanceof Error ? err.message : String(err);
                process.stderr.write(`robotnet: catch-up failed: ${detail}\n`);
              });
            }
          },
          onFrame: (frame, raw) => {
            const advance = recordIfFresh(frame, watermark);
            if (advance === null) return;
            watermark = advance;
            void saveWatermark(config, identity.handle, watermark, opts.watermark);
            out(raw);
          },
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
            indicator.close();
            writeTerminating(formatTerminalFailure(failure));
            process.exit(1);
          },
          ...(opts.maxAttempts !== undefined ? { maxAttempts: opts.maxAttempts } : {}),
        });

        process.on("SIGINT", () => {
          indicator.close();
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
  /** commander's `--no-catch-up` produces `catchUp: false` here. */
  readonly catchUp: boolean;
  readonly watermark?: string;
}

function parsePositiveIntArg(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1 || String(n) !== raw.trim()) {
    throw new RobotNetCLIError(`expected a positive integer, got "${raw}"`);
  }
  return n;
}

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

/**
 * Advance the watermark for a live frame and return the new watermark
 * iff the frame is fresh. Returns `null` for duplicates (envelope id
 * we've already surfaced) so the caller can suppress emission.
 *
 * Monitor facts don't carry their own (created_at, envelope_id) cursor
 * — they reference the underlying envelope by id but fire after the
 * envelope landed. Forward them through without touching the watermark
 * so we don't accidentally regress the catch-up cursor.
 */
function recordIfFresh(
  frame: ServerFrame,
  watermark: Parameters<typeof advanceWatermark>[0],
): ReturnType<typeof advanceWatermark> | null {
  if (frame.op === "monitor.fact") {
    // Monitor facts are sender-side observability — they're emitted
    // separately from the envelope's own placement in the mailbox. Treat
    // them as fire-and-forget for watermark purposes; the listener will
    // surface them either way and the reconnecting listener's own
    // (envelope_id, recipient_handle, fact) LRU handles duplicates.
    return watermark;
  }
  const push = frame as PushFrame;
  if (hasSeen(watermark, push.id)) return null;
  return advanceWatermark(watermark, [
    { id: push.id, created_at: push.created_at },
  ]);
}

interface CatchUpArgs {
  readonly config: CLIConfig;
  readonly handle: string;
  readonly token: string | undefined;
  readonly getWatermark: () => Parameters<typeof advanceWatermark>[0];
  readonly setWatermark: (
    next: ReturnType<typeof advanceWatermark>,
  ) => void;
  readonly watermarkPath: string | undefined;
  /** Emit a single envelope notification to stdout. */
  readonly emit: (frame: PushFrame, raw: string) => void;
}

/**
 * Walk `GET /mailbox?order=asc` paginated from the persisted watermark
 * until `next_cursor` is null, deduping each header against the in-memory
 * watermark and persisting after each page.
 */
async function runCatchUp(args: CatchUpArgs): Promise<void> {
  const { token, baseUrl } = await resolveAgentBearer(
    args.config,
    args.handle,
    args.token,
  );
  const mailbox = new MailboxClient(baseUrl, token);
  for (;;) {
    const cursor = watermarkToCursor(args.getWatermark());
    const page = await mailbox.list({
      order: "asc",
      limit: 1000,
      ...(cursor !== null ? { after: cursor } : {}),
    });

    const fresh: { readonly id: string; readonly created_at: Timestamp }[] = [];
    for (const header of page.envelope_headers) {
      if (hasSeen(args.getWatermark(), header.id)) continue;
      // Watermark is advanced after each header so subsequent emissions
      // in this page can't double-fire (e.g. when the operator returns
      // the same envelope from overlapping pages).
      args.setWatermark(
        advanceWatermark(args.getWatermark(), [
          { id: header.id, created_at: header.created_at },
        ]),
      );
      fresh.push({ id: header.id, created_at: header.created_at });
      args.emit(header, JSON.stringify(header));
    }

    if (fresh.length > 0) {
      await saveWatermark(
        args.config,
        args.handle,
        args.getWatermark(),
        args.watermarkPath,
      );
    }

    if (page.next_cursor === null) return;
  }
}
