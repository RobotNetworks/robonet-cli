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
 * Split into three subcommands so the verb each performs is unambiguous
 * and the surface lines up with the rest of the CLI (`identity show`,
 * `agents show`, `me show`, etc.):
 *
 *   - `mailbox list` — paginate the agent's feed (headers only).
 *     Defaults to the recipient feed (`--direction in`); operator
 *     extensions expose `out` (sent) and `both`.
 *   - `mailbox show <id…>` — fetch one or more bodies; auto-marks the
 *     fetched envelopes read because reading is what the verb means on
 *     the wire (`GET /messages/{id}`).
 *   - `mailbox mark-read <id…>` — mark one or more envelopes read
 *     without fetching the body. Maps directly to `POST /mailbox/read`.
 *
 * Pagination on `list` is keyset over `(created_at, envelope_id)`.
 *
 * `--show`/`--mark-read` flags from earlier releases are gone — the new
 * subcommands replace them; `mailbox` with no subcommand prints help.
 */
export function registerMailboxCommand(program: Command): void {
  program.addCommand(makeMailboxCommand());
}

function makeMailboxCommand(): Command {
  const mailbox = new Command("mailbox").description(
    "List, fetch, and mark envelopes in the calling agent's mailbox",
  );
  mailbox.addCommand(makeListCmd());
  mailbox.addCommand(makeShowCmd());
  mailbox.addCommand(makeMarkReadCmd());
  return mailbox;
}

function makeListCmd(): Command {
  return new Command("list")
    .description(
      "Paginate the calling agent's mailbox feed (headers only; use `mailbox show` to fetch bodies)",
    )
    .option("--as <handle>", "Act as this agent handle", handleArg)
    .option(
      "--direction <direction>",
      "Feed: in (received, default), out (sent), or both (combined)",
      parseDirection,
      "in" as MailboxDirection,
    )
    .option(
      "--unread",
      "Restrict listing to unread envelopes (--direction=in only)",
      false,
    )
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
    .addOption(tokenOption())
    .option("--json", "Emit machine-readable JSON", false)
    .action(async (opts: ListOpts, cmd: Command) => {
      if (
        (opts.afterCreatedAt !== undefined) !==
        (opts.afterEnvelopeId !== undefined)
      ) {
        throw new RobotNetCLIError(
          "--after-created-at and --after-envelope-id must be supplied together.",
        );
      }
      if (opts.unread && opts.direction !== "in") {
        // Surface the constraint explicitly rather than letting the
        // server silently ignore --unread; read-state is per-recipient
        // and has no sender-side meaning.
        throw new RobotNetCLIError(
          "--unread is only meaningful with --direction=in (recipient feed).",
        );
      }
      const { config, identity } = await loadConfigForAgentCommand(cmd, opts.as);
      const { token, baseUrl } = await resolveAgentBearer(
        config,
        identity.handle,
        opts.token,
      );
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
      renderHeaders(result.envelope_headers, { unreadFilter: opts.unread });
      if (result.next_cursor != null) {
        // ``!= null`` (not ``!== null``) so we also catch the
        // ``undefined`` shape the wire emits when FastAPI's
        // ``response_model_exclude_none=True`` strips the field
        // rather than leaving an explicit ``null``.
        out("");
        out(
          `(more — resume with --after-created-at ${result.next_cursor.created_at} ` +
            `--after-envelope-id ${result.next_cursor.envelope_id})`,
        );
      }
    });
}

function makeShowCmd(): Command {
  return new Command("show")
    .description(
      "Fetch the body for one or more envelope ids (auto-marks each fetched envelope read)",
    )
    .argument("<ids...>", "Envelope ids (Crockford-base32 ULIDs)", collectIdsArg, [])
    .option("--as <handle>", "Act as this agent handle", handleArg)
    .addOption(tokenOption())
    .option("--json", "Emit machine-readable JSON", false)
    .action(async (rawIds: string[], opts: ShowOpts, cmd: Command) => {
      const ids = ensureValidIds(rawIds);
      const { config, identity } = await loadConfigForAgentCommand(cmd, opts.as);
      const { token, baseUrl } = await resolveAgentBearer(
        config,
        identity.handle,
        opts.token,
      );
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
    });
}

function makeMarkReadCmd(): Command {
  return new Command("mark-read")
    .description(
      "Mark one or more envelopes read without fetching the body (POST /mailbox/read)",
    )
    .argument("<ids...>", "Envelope ids (Crockford-base32 ULIDs)", collectIdsArg, [])
    .option("--as <handle>", "Act as this agent handle", handleArg)
    .addOption(tokenOption())
    .option("--json", "Emit machine-readable JSON", false)
    .action(async (rawIds: string[], opts: MarkReadOpts, cmd: Command) => {
      const ids = ensureValidIds(rawIds);
      const { config, identity } = await loadConfigForAgentCommand(cmd, opts.as);
      const { token, baseUrl } = await resolveAgentBearer(
        config,
        identity.handle,
        opts.token,
      );
      const mailbox = new MailboxClient(baseUrl, token);
      const result = await mailbox.markRead(ids);
      if (opts.json) {
        out(JSON.stringify(result, null, 2));
        return;
      }
      out(`Marked ${result.read.length} envelope(s) read.`);
    });
}

interface ListOpts {
  readonly as?: string;
  readonly token?: string;
  readonly direction: MailboxDirection;
  readonly unread: boolean;
  readonly limit: number;
  readonly order: MailboxOrder;
  readonly afterCreatedAt?: Timestamp;
  readonly afterEnvelopeId?: EnvelopeId;
  readonly json: boolean;
}

interface ShowOpts {
  readonly as?: string;
  readonly token?: string;
  readonly json: boolean;
}

interface MarkReadOpts {
  readonly as?: string;
  readonly token?: string;
  readonly json: boolean;
}

/**
 * Commander variadic positional collector. Each subsequent positional
 * is appended to the accumulator so `show A B C` produces `[A, B, C]`.
 */
function collectIdsArg(value: string, prev: string[]): string[] {
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
  if (ids.length === 0) {
    throw new RobotNetCLIError("expected one or more envelope ids");
  }
  return ids.map((id) => envelopeIdArg(id));
}

function renderHeaders(
  headers: readonly PushFrame[],
  opts: { unreadFilter: boolean },
): void {
  if (headers.length === 0) {
    out("(no envelopes)");
    return;
  }
  for (const h of headers) {
    const ts = new Date(h.created_at).toISOString();
    // FastAPI may serialize unset optional fields as JSON ``null`` —
    // treat null and absent identically so the row never renders the
    // literal "null".
    const subject = h.subject ?? "(No subject)";
    const size = h.size_hint != null ? ` ${h.size_hint}tok` : "";
    const dirTag = h.direction != null ? ` <${h.direction}>` : "";
    // The spec wire route doesn't carry the ``unread`` field, so
    // ``h.unread === true`` never trips on a default ``direction=in``
    // listing. When the caller passed ``--unread``, every returned
    // row is unread by definition — stamp the marker client-side.
    const unreadMark =
      h.unread === true || opts.unreadFilter ? "• " : "  ";
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
