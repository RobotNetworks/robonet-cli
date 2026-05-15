import { Command } from "commander";

import { resolveAgentBearer } from "../asmtp/auth-resolver.js";
import { handleArg } from "../asmtp/handles.js";
import {
  MailboxClient,
  type MailboxDirection,
  type MailboxOrder,
} from "../asmtp/mailbox-client.js";
import { MessagesClient } from "../asmtp/messages-client.js";
import type {
  EnvelopeId,
  PushFrame,
  Timestamp,
} from "../asmtp/types.js";
import { RobotNetCLIError } from "../errors.js";
import { loadConfigForAgentCommand, out, tokenOption } from "./shared.js";

/**
 * `robotnet mailbox` — list, fetch, and mark envelopes in the
 * calling agent's mailbox.
 *
 * Headers only by default. Use `--show <id>...` to fetch one or more
 * bodies (auto-marks read), or `--mark-read <id>...` to mark without
 * fetching. Pagination is keyset over `(created_at, envelope_id)`.
 *
 * ``--direction`` chooses the feed:
 *   - ``in`` (default) — envelopes the agent has received. ASMTP wire
 *     spec; byte-for-byte compatible with any conformant operator.
 *   - ``out`` — envelopes the agent has sent. Operator extension.
 *   - ``both`` — combined feed; each header tagged with a ``direction``
 *     field (``in`` / ``out`` / ``self``). Operator extension.
 */
export function registerMailboxCommand(program: Command): void {
  program.addCommand(makeMailboxCommand());
}

function makeMailboxCommand(): Command {
  return new Command("mailbox")
    .description("List, fetch, and mark envelopes in the calling agent's mailbox")
    .option("--as <handle>", "Act as this agent handle", handleArg)
    .option(
      "--direction <direction>",
      "Feed: in (received, default), out (sent), or both (combined)",
      parseDirection,
      "in" as MailboxDirection,
    )
    .option("--unread", "Restrict listing to unread envelopes (--direction=in only)", false)
    .option(
      "--limit <n>",
      "Maximum entries to return (1..1000, default 20)",
      parseLimit,
      20,
    )
    .option(
      "--order <order>",
      "Order asc (oldest first) or desc (newest first, default)",
      parseOrder,
      "desc" as MailboxOrder,
    )
    .option(
      "--after-created-at <ms>",
      "Cursor leg: created_at to resume after (must pair with --after-envelope-id)",
      parseTimestamp,
    )
    .option(
      "--after-envelope-id <id>",
      "Cursor leg: envelope id to resume after (must pair with --after-created-at)",
      envelopeIdArg,
    )
    .option(
      "--show <id>",
      "Fetch the body for one or more envelope ids (auto-marks read; repeatable)",
      collectRepeatable,
      [] as string[],
    )
    .option(
      "--mark-read <id>",
      "Mark one or more envelope ids read without fetching (repeatable)",
      collectRepeatable,
      [] as string[],
    )
    .addOption(tokenOption())
    .option("--json", "Emit machine-readable JSON", false)
    .action(async (opts: MailboxOpts, cmd: Command) => {
      if (
        (opts.afterCreatedAt !== undefined) !==
        (opts.afterEnvelopeId !== undefined)
      ) {
        throw new RobotNetCLIError(
          "--after-created-at and --after-envelope-id must be supplied together.",
        );
      }
      const { config, identity } = await loadConfigForAgentCommand(cmd, opts.as);
      const { token, baseUrl } = await resolveAgentBearer(
        config,
        identity.handle,
        opts.token,
      );

      // Body-fetch and mark-read modes short-circuit listing entirely —
      // they're the explicit "I know the id(s) I care about" path.
      if (opts.show.length > 0) {
        const ids = ensureValidIds(opts.show);
        const client = new MessagesClient(baseUrl, token);
        const envelopes = await client.fetchBatch(ids);
        if (opts.json) {
          out(JSON.stringify({ envelopes }, null, 2));
          return;
        }
        for (const envelope of envelopes) {
          out(formatEnvelope(envelope));
        }
        if (envelopes.length < ids.length) {
          out(
            `(${ids.length - envelopes.length} envelope(s) omitted — not found or not entitled)`,
          );
        }
        return;
      }
      if (opts.markRead.length > 0) {
        const ids = ensureValidIds(opts.markRead);
        const mailbox = new MailboxClient(baseUrl, token);
        const result = await mailbox.markRead(ids);
        if (opts.json) {
          out(JSON.stringify(result, null, 2));
          return;
        }
        out(`Marked ${result.read.length} envelope(s) read.`);
        return;
      }

      if (opts.unread && opts.direction !== "in") {
        // Surface the constraint explicitly rather than letting the
        // server silently ignore --unread; read-state is per-recipient
        // and has no sender-side meaning.
        throw new RobotNetCLIError(
          "--unread is only meaningful with --direction=in (recipient feed).",
        );
      }
      const mailbox = new MailboxClient(baseUrl, token);
      const result = await mailbox.list({
        order: opts.order,
        limit: opts.limit,
        direction: opts.direction,
        ...(opts.unread ? { unread: true } : {}),
        ...(opts.afterCreatedAt !== undefined && opts.afterEnvelopeId !== undefined
          ? {
              after: {
                created_at: opts.afterCreatedAt,
                envelope_id: opts.afterEnvelopeId,
              },
            }
          : {}),
      });
      if (opts.json) {
        out(JSON.stringify(result, null, 2));
        return;
      }
      renderHeaders(result.envelope_headers);
      if (result.next_cursor !== null) {
        out("");
        out(
          `(more — resume with --after-created-at ${result.next_cursor.created_at} ` +
            `--after-envelope-id ${result.next_cursor.envelope_id})`,
        );
      }
    });
}

interface MailboxOpts {
  readonly as?: string;
  readonly token?: string;
  readonly direction: MailboxDirection;
  readonly unread: boolean;
  readonly limit: number;
  readonly order: MailboxOrder;
  readonly afterCreatedAt?: Timestamp;
  readonly afterEnvelopeId?: EnvelopeId;
  readonly show: string[];
  readonly markRead: string[];
  readonly json: boolean;
}

function collectRepeatable(value: string, prev: string[]): string[] {
  return [...prev, value];
}

function parseLimit(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n < 1 || n > 1000) {
    throw new RobotNetCLIError(
      `--limit must be an integer between 1 and 1000 (got ${JSON.stringify(value)})`,
    );
  }
  return n;
}

function parseOrder(value: string): MailboxOrder {
  if (value !== "asc" && value !== "desc") {
    throw new RobotNetCLIError(
      `--order must be 'asc' or 'desc' (got ${JSON.stringify(value)})`,
    );
  }
  return value;
}

function parseDirection(value: string): MailboxDirection {
  if (value !== "in" && value !== "out" && value !== "both") {
    throw new RobotNetCLIError(
      `--direction must be 'in', 'out', or 'both' (got ${JSON.stringify(value)})`,
    );
  }
  return value;
}

function parseTimestamp(value: string): Timestamp {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n < 0 || String(n) !== value.trim()) {
    throw new RobotNetCLIError(
      `expected a non-negative integer (epoch ms), got ${JSON.stringify(value)}`,
    );
  }
  return n;
}

const ENVELOPE_ID_RE = /^01[0-9A-HJKMNP-TV-Z]{24}$/;
function envelopeIdArg(value: string): EnvelopeId {
  if (!ENVELOPE_ID_RE.test(value)) {
    throw new RobotNetCLIError(
      `invalid envelope id ${JSON.stringify(value)}; expected a 26-char Crockford-base32 ULID`,
    );
  }
  return value;
}

function ensureValidIds(ids: readonly string[]): EnvelopeId[] {
  return ids.map((id) => envelopeIdArg(id));
}

function renderHeaders(headers: readonly PushFrame[]): void {
  if (headers.length === 0) {
    out("(no envelopes)");
    return;
  }
  for (const h of headers) {
    const ts = new Date(h.created_at).toISOString();
    // Optional wire fields may come through as JSON ``null`` (FastAPI
    // doesn't strip null defaults by default) — treat null and absent
    // identically here so the row doesn't render the literal "null".
    const subject = h.subject ?? "(No subject)";
    const size = h.size_hint != null ? ` ${h.size_hint}tok` : "";
    // Operator-extension fields: stamp inline so a `direction=both`
    // listing reads naturally, and surface unread state as a leading
    // "•" for the spec-default direction=in feed. Both fields are
    // ignored when the server didn't stamp them.
    const dirTag = h.direction != null ? ` <${h.direction}>` : "";
    const unreadMark = h.unread === true ? "• " : "  ";
    out(
      `${unreadMark}${ts}  ${h.id}${dirTag}  ${h.from} . ${subject} [${h.type_hint}${size}]`,
    );
  }
}

interface RenderableEnvelope {
  readonly id: EnvelopeId;
  readonly from: string;
  readonly to: readonly string[];
  readonly cc?: readonly string[] | null;
  readonly subject?: string | null;
  readonly in_reply_to?: EnvelopeId | null;
  readonly date_ms: Timestamp;
  readonly content_parts: readonly unknown[];
}

function formatEnvelope(envelope: RenderableEnvelope): string {
  const lines: string[] = [];
  lines.push(`Envelope ${envelope.id}`);
  lines.push(`  from:    ${envelope.from}`);
  lines.push(`  to:      ${envelope.to.join(", ")}`);
  if (envelope.cc != null && envelope.cc.length > 0) {
    lines.push(`  cc:      ${envelope.cc.join(", ")}`);
  }
  if (envelope.subject != null) {
    lines.push(`  subject: ${envelope.subject}`);
  }
  if (envelope.in_reply_to != null) {
    lines.push(`  in_reply_to: ${envelope.in_reply_to}`);
  }
  lines.push(`  date_ms: ${envelope.date_ms}`);
  lines.push("  content_parts:");
  lines.push(
    JSON.stringify(envelope.content_parts, null, 2)
      .split("\n")
      .map((l) => `    ${l}`)
      .join("\n"),
  );
  return lines.join("\n");
}
