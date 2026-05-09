import * as fs from "node:fs";
import * as path from "node:path";

import { Command } from "commander";

import { resolveAgentBearer, resolveSessionClient } from "../asp/auth-resolver.js";
import { AspApiError } from "../asp/errors.js";
import {
  AspFilesClient,
  type FileUploadResponse,
} from "../asp/files-client.js";
import {
  assertValidHandle,
  handleArg,
  handlesArg,
} from "../asp/handles.js";
import type {
  ContentRequest,
  ContentPartRequest,
  SessionWire,
  UnknownSessionEvent,
} from "../asp/types.js";
import type { CLIConfig } from "../config.js";
import { RobotNetCLIError } from "../errors.js";
import { loadConfigForAgentCommand, out } from "./asp-shared.js";

/**
 * `robotnet session` — manage ASP sessions as the calling agent.
 *
 * Each leaf authenticates with the agent's bearer token. Resolution order:
 *   1. `--token <tok>` flag
 *   2. The shared SQLite credential store, keyed by `(network, handle)`.
 *      Local bearers are written by `robotnet admin agent create` /
 *      `admin agent rotate-token`; remote bearers by `robotnet login`.
 *
 * The acting agent is resolved by `--as <handle>` > `ROBOTNET_AGENT` env >
 * the directory's `.robotnet/config.json` `identities` map. The same file's
 * `network` field also pins the workspace network, so a project pinned to
 * `local` "just works" from inside its directory without `--network`.
 */
export function registerSessionCommand(program: Command): void {
  const session = new Command("session").description(
    "Manage ASP sessions as the calling agent",
  );

  session.addCommand(makeCreateCmd());
  session.addCommand(makeListCmd());
  session.addCommand(makeShowCmd());
  session.addCommand(makeJoinCmd());
  session.addCommand(makeInviteCmd());
  session.addCommand(makeSendCmd());
  session.addCommand(makeLeaveCmd());
  session.addCommand(makeEndCmd());
  session.addCommand(makeReopenCmd());
  session.addCommand(makeEventsCmd());

  program.addCommand(session);
}

// ── create ───────────────────────────────────────────────────────────────────

function makeCreateCmd(): Command {
  return new Command("create")
    .description("Create a new session")
    .option("--as <handle>", "Act as this agent handle", handleArg)
    .option("--invite <handles>", "Comma-separated handles to invite")
    .option("--topic <text>", "Session topic")
    .option("--message <text>", "Send an initial message")
    .option(
      "--end-after-send",
      "End the session immediately after the initial message",
      false,
    )
    .addOption(tokenOption())
    .option("--json", "Emit machine-readable JSON", false)
    .action(async (opts: CreateOpts, cmd: Command) => {
      const { config, identity } = await loadConfigForAgentCommand(cmd, opts.as);
      const client = await resolveSessionClient(config, identity.handle, opts.token);
      const invite = parseInviteList(opts.invite);
      const result = await client.createSession({
        ...(invite !== undefined ? { invite } : {}),
        ...(opts.topic !== undefined ? { topic: opts.topic } : {}),
        ...(opts.message !== undefined
          ? { initialMessage: { content: opts.message } }
          : {}),
        ...(opts.endAfterSend ? { endAfterSend: true } : {}),
      });
      if (opts.json) {
        out(JSON.stringify(result, null, 2));
        return;
      }
      out(`Created session ${result.session_id}.`);
      if (result.sequence !== undefined) {
        out(`  Message sequence: ${result.sequence}`);
      }
    });
}

interface CreateOpts {
  readonly as?: string;
  readonly invite?: string;
  readonly topic?: string;
  readonly message?: string;
  readonly endAfterSend: boolean;
  readonly token?: string;
  readonly json: boolean;
}

// ── list ─────────────────────────────────────────────────────────────────────

function makeListCmd(): Command {
  return new Command("list")
    .description("List sessions the agent is part of")
    .option("--as <handle>", "Act as this agent handle", handleArg)
    .addOption(tokenOption())
    .option("--json", "Emit machine-readable JSON", false)
    .action(async (opts: AgentLeafOpts, cmd: Command) => {
      const { config, identity } = await loadConfigForAgentCommand(cmd, opts.as);
      const client = await resolveSessionClient(config, identity.handle, opts.token);
      const sessions = await client.listSessions();
      if (opts.json) {
        out(JSON.stringify({ sessions }, null, 2));
        return;
      }
      if (sessions.length === 0) {
        out(
          `No sessions found for ${identity.handle} on network "${config.network.name}".`,
        );
        return;
      }
      out(formatSessionTable(sessions));
    });
}

// ── show ─────────────────────────────────────────────────────────────────────

function makeShowCmd(): Command {
  return new Command("show")
    .description("Show details for a session")
    .argument("<session-id>", "Session ID")
    .option("--as <handle>", "Act as this agent handle", handleArg)
    .addOption(tokenOption())
    .option("--json", "Emit machine-readable JSON", false)
    .action(async (sessionId: string, opts: AgentLeafOpts, cmd: Command) => {
      const { config, identity } = await loadConfigForAgentCommand(cmd, opts.as);
      const client = await resolveSessionClient(config, identity.handle, opts.token);
      const session = await client.showSession(sessionId);
      if (opts.json) {
        out(JSON.stringify(session, null, 2));
        return;
      }
      printSession(session);
    });
}

// ── join ─────────────────────────────────────────────────────────────────────

function makeJoinCmd(): Command {
  return new Command("join")
    .description("Join a session the agent has been invited to")
    .argument("<session-id>", "Session ID")
    .option("--as <handle>", "Act as this agent handle", handleArg)
    .addOption(tokenOption())
    .action(async (sessionId: string, opts: AgentLeafOpts, cmd: Command) => {
      const { config, identity } = await loadConfigForAgentCommand(cmd, opts.as);
      const client = await resolveSessionClient(config, identity.handle, opts.token);
      await client.joinSession(sessionId);
      out(`Joined session ${sessionId}.`);
    });
}

// ── invite ───────────────────────────────────────────────────────────────────

function makeInviteCmd(): Command {
  return new Command("invite")
    .description("Invite one or more agents to a session")
    .argument("<session-id>", "Session ID")
    .argument("<handles...>", "Agent handles to invite", handlesArg)
    .option("--as <handle>", "Act as this agent handle", handleArg)
    .addOption(tokenOption())
    .option("--json", "Emit machine-readable JSON", false)
    .action(
      async (
        sessionId: string,
        handles: string[],
        opts: AgentLeafOpts,
        cmd: Command,
      ) => {
        const { config, identity } = await loadConfigForAgentCommand(cmd, opts.as);
        const client = await resolveSessionClient(config, identity.handle, opts.token);
        const result = await inviteWith404Hint(
          () => client.inviteToSession(sessionId, handles),
          sessionId,
        );
        const invitedSet = new Set(result.invited);
        const omitted = handles.filter((h) => !invitedSet.has(h));
        if (opts.json) {
          out(JSON.stringify({ invited: result.invited, omitted }, null, 2));
          return;
        }
        if (result.invited.length > 0) {
          out(`Invited: ${result.invited.join(", ")}`);
        }
        if (omitted.length > 0) {
          // ASP §6.2: invitation refusals are not enumerable to the inviter.
          // Surface that explicitly so the user does not assume it's a bug.
          out(
            `Omitted: ${omitted.join(", ")} ` +
              "(unknown, already participant, blocked, or with a restrictive policy — " +
              "the protocol does not surface which, by design)",
          );
        }
        if (result.invited.length === 0 && omitted.length === 0) {
          out("No agents were invited.");
        }
      },
    );
}

/**
 * Translate a 404 from the invite endpoint into a plainspoken hint.
 *
 * Per ASP §6.2 / the operator's privacy invariant, a 404 here is deliberately
 * ambiguous between "session does not exist" and "caller is not a participant
 * in it" — the operator returns the same response for both so an outsider
 * can't probe for session existence. The raw `http_404` line gives the user
 * none of that context; this hint preserves the privacy property while
 * naming both possibilities.
 *
 * Note: invitee-not-invitable is *not* a 404 case — that path returns 200
 * with the unreachable invitee silently absent from `invited` (handled by
 * the omitted-list rendering above).
 */
async function inviteWith404Hint<T>(
  call: () => Promise<T>,
  sessionId: string,
): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof AspApiError && err.status === 404) {
      throw new RobotNetCLIError(
        `No invite was sent for session ${sessionId}. ` +
          "Either the session does not exist, or you are not a participant in it. " +
          "(The network returns the same response for both to preserve privacy.)",
      );
    }
    throw err;
  }
}

// ── send ─────────────────────────────────────────────────────────────────────

function makeSendCmd(): Command {
  return new Command("send")
    .description(
      "Send a message to a session. Optional positional <message> is a plain text part; combine with --file/--image/--data flags for multipart content.",
    )
    .argument("<session-id>", "Session ID")
    .argument("[message]", "Plain text part (optional when using --file/--image/--data/--content)")
    .option("--as <handle>", "Act as this agent handle", handleArg)
    .option(
      "--file <path>",
      "Upload <path> to the network and reference it as a file part (repeatable)",
      collectRepeatable,
      [] as string[],
    )
    .option(
      "--image <path>",
      "Upload <path> as an image part (repeatable)",
      collectRepeatable,
      [] as string[],
    )
    .option(
      "--data <json-or-@file>",
      "Add a `data` part. Either inline JSON object literal or `@<path>` to read from a file.",
    )
    .option(
      "--content <@file.json>",
      "Read the entire `Content` value from a file (mutually exclusive with --file/--image/--data and the positional message).",
    )
    .option(
      "--content-stdin",
      "Read the entire `Content` value from stdin (mutually exclusive with --content / --file / --image / --data / message).",
      false,
    )
    .option(
      "--idempotency-key <key>",
      "Stable Idempotency-Key for the send. The CLI auto-generates a fresh key per call by default; pass this to control replay (e.g. retry the same logical message and get the same `(message_id, sequence)` back).",
    )
    .addOption(tokenOption())
    .option("--json", "Emit machine-readable JSON", false)
    .action(
      async (
        sessionId: string,
        message: string | undefined,
        opts: SendOpts,
        cmd: Command,
      ) => {
        const { config, identity } = await loadConfigForAgentCommand(cmd, opts.as);
        const content = await buildContent(
          { ...opts, message },
          config,
          identity.handle,
        );
        const client = await resolveSessionClient(config, identity.handle, opts.token);
        const result = await client.sendMessage(sessionId, content, {
          ...(opts.idempotencyKey !== undefined
            ? { idempotencyKey: opts.idempotencyKey }
            : {}),
        });
        if (opts.json) {
          out(JSON.stringify(result, null, 2));
          return;
        }
        out(`Message sent (id=${result.message_id}, seq=${result.sequence}).`);
      },
    );
}

interface SendOpts {
  readonly as?: string;
  readonly token?: string;
  readonly json: boolean;
  readonly file: string[];
  readonly image: string[];
  readonly data?: string;
  readonly content?: string;
  readonly contentStdin: boolean;
  readonly idempotencyKey?: string;
  readonly message?: string;
}

function collectRepeatable(value: string, prev: string[]): string[] {
  return [...prev, value];
}

/** Build a ``ContentRequest`` from the send-command flag combination.
 *
 *  Precedence (mutually exclusive):
 *    1. ``--content-stdin`` — read entire Content from stdin.
 *    2. ``--content @file`` — read entire Content from a file.
 *    3. positional ``<message>`` and/or ``--file/--image/--data`` — assemble parts.
 *
 *  Within (3), parts are emitted in this order: text (positional),
 *  files (in flag order), images (in flag order), data. If only the
 *  positional is supplied, the result is a plain string (one text part)
 *  to keep simple sends compact on the wire.
 */
async function buildContent(
  opts: {
    readonly message?: string;
    readonly file: readonly string[];
    readonly image: readonly string[];
    readonly data?: string;
    readonly content?: string;
    readonly contentStdin: boolean;
    readonly token?: string;
  },
  config: CLIConfig,
  callerHandle: string,
): Promise<ContentRequest> {
  const usingExplicitContent = opts.contentStdin || opts.content !== undefined;
  const usingPartFlags =
    opts.file.length > 0 ||
    opts.image.length > 0 ||
    opts.data !== undefined ||
    opts.message !== undefined;

  if (usingExplicitContent && usingPartFlags) {
    throw new RobotNetCLIError(
      "--content / --content-stdin is mutually exclusive with --file, --image, --data, and the positional message.",
    );
  }
  if (opts.contentStdin && opts.content !== undefined) {
    throw new RobotNetCLIError(
      "Use --content OR --content-stdin, not both.",
    );
  }

  if (opts.contentStdin) {
    return parseContentJson(await readStdin(), "<stdin>");
  }
  if (opts.content !== undefined) {
    const trimmed = opts.content.startsWith("@")
      ? opts.content.slice(1)
      : opts.content;
    const json = await fs.promises.readFile(trimmed, "utf8");
    return parseContentJson(json, trimmed);
  }

  if (
    opts.message === undefined &&
    opts.file.length === 0 &&
    opts.image.length === 0 &&
    opts.data === undefined
  ) {
    throw new RobotNetCLIError(
      "session send needs a message argument or --file/--image/--data/--content[-stdin].",
    );
  }

  // Simple text-only path: keep the wire compact.
  if (
    opts.message !== undefined &&
    opts.file.length === 0 &&
    opts.image.length === 0 &&
    opts.data === undefined
  ) {
    return opts.message;
  }

  // Mixed-part assembly. Need a files-client to upload --file/--image inputs.
  const parts: ContentPartRequest[] = [];
  if (opts.message !== undefined) {
    parts.push({ type: "text", text: opts.message });
  }

  if (opts.file.length > 0 || opts.image.length > 0) {
    const { token, baseUrl } = await resolveAgentBearer(
      config,
      callerHandle,
      opts.token,
    );
    const files = new AspFilesClient(baseUrl, token);
    for (const filePath of opts.file) {
      const upload = await uploadFile(files, filePath);
      // Carry name / mime_type / size from the upload response so receivers
      // can render the file without a second `GET /files/{file_id}` round-trip
      // just to learn the metadata.
      parts.push({
        type: "file",
        file_id: upload.id,
        name: upload.filename,
        mime_type: upload.content_type,
        size: upload.size_bytes,
      });
    }
    for (const imgPath of opts.image) {
      const upload = await uploadFile(files, imgPath);
      parts.push({
        type: "image",
        file_id: upload.id,
        name: upload.filename,
        mime_type: upload.content_type,
      });
    }
  }

  if (opts.data !== undefined) {
    parts.push({ type: "data", data: parseDataLiteral(opts.data) });
  }
  return parts;
}

async function uploadFile(
  client: AspFilesClient,
  filePath: string,
): Promise<FileUploadResponse> {
  let bytes: Uint8Array;
  try {
    bytes = await fs.promises.readFile(filePath);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new RobotNetCLIError(`Could not read ${filePath}: ${detail}`);
  }
  const filename = path.basename(filePath);
  const contentType = guessContentType(filename);
  return await client.upload({ bytes, filename, contentType });
}

function parseContentJson(text: string, source: string): ContentRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new RobotNetCLIError(
      `Failed to parse JSON from ${source}: ${detail}`,
    );
  }
  if (typeof parsed === "string") return parsed;
  if (Array.isArray(parsed)) return parsed as ContentPartRequest[];
  throw new RobotNetCLIError(
    `Content from ${source} must be a string or an array of parts.`,
  );
}

function parseDataLiteral(raw: string): Readonly<Record<string, unknown>> {
  let text = raw;
  if (raw.startsWith("@")) {
    const filePath = raw.slice(1);
    try {
      text = fs.readFileSync(filePath, "utf8");
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new RobotNetCLIError(
        `Could not read --data file ${filePath}: ${detail}`,
      );
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new RobotNetCLIError(`--data must be valid JSON: ${detail}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RobotNetCLIError(
      "--data must be a JSON object (DataPart.data is `{...}`).",
    );
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".csv": "text/csv",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
};

function guessContentType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return CONTENT_TYPE_BY_EXT[ext] ?? "application/octet-stream";
}

// ── leave ─────────────────────────────────────────────────────────────────────

function makeLeaveCmd(): Command {
  return new Command("leave")
    .description("Leave a session")
    .argument("<session-id>", "Session ID")
    .option("--as <handle>", "Act as this agent handle", handleArg)
    .addOption(tokenOption())
    .action(async (sessionId: string, opts: AgentLeafOpts, cmd: Command) => {
      const { config, identity } = await loadConfigForAgentCommand(cmd, opts.as);
      const client = await resolveSessionClient(config, identity.handle, opts.token);
      await client.leaveSession(sessionId);
      out(`Left session ${sessionId}.`);
    });
}

// ── end ───────────────────────────────────────────────────────────────────────

function makeEndCmd(): Command {
  return new Command("end")
    .description("End a session")
    .argument("<session-id>", "Session ID")
    .option("--as <handle>", "Act as this agent handle", handleArg)
    .addOption(tokenOption())
    .action(async (sessionId: string, opts: AgentLeafOpts, cmd: Command) => {
      const { config, identity } = await loadConfigForAgentCommand(cmd, opts.as);
      const client = await resolveSessionClient(config, identity.handle, opts.token);
      await client.endSession(sessionId);
      out(`Ended session ${sessionId}.`);
    });
}

// ── reopen ────────────────────────────────────────────────────────────────────

function makeReopenCmd(): Command {
  return new Command("reopen")
    .description("Reopen an ended session")
    .argument("<session-id>", "Session ID")
    .option("--as <handle>", "Act as this agent handle", handleArg)
    .option("--invite <handles>", "Comma-separated handles to re-invite")
    .option(
      "--message <text>",
      "Send an initial message to the reopened session",
    )
    .addOption(tokenOption())
    .action(async (sessionId: string, opts: ReopenOpts, cmd: Command) => {
      const { config, identity } = await loadConfigForAgentCommand(cmd, opts.as);
      const client = await resolveSessionClient(config, identity.handle, opts.token);
      const invite = parseInviteList(opts.invite);
      await client.reopenSession(sessionId, {
        ...(invite !== undefined ? { invite } : {}),
        ...(opts.message !== undefined
          ? { initialMessage: { content: opts.message } }
          : {}),
      });
      out(`Reopened session ${sessionId}.`);
    });
}

interface ReopenOpts {
  readonly as?: string;
  readonly invite?: string;
  readonly message?: string;
  readonly token?: string;
}

// ── events ────────────────────────────────────────────────────────────────────

function makeEventsCmd(): Command {
  return new Command("events")
    .description("Fetch events from a session's transcript")
    .argument("<session-id>", "Session ID")
    .option("--as <handle>", "Act as this agent handle", handleArg)
    .option(
      "--after <sequence>",
      "Only return events after this sequence number",
      parsePositiveIntArg,
    )
    .option(
      "--limit <n>",
      "Maximum number of events to return (1-1000)",
      parsePositiveIntArg,
    )
    .addOption(tokenOption())
    .option("--json", "Emit machine-readable JSON", false)
    .action(async (sessionId: string, opts: EventsOpts, cmd: Command) => {
      const { config, identity } = await loadConfigForAgentCommand(cmd, opts.as);
      const client = await resolveSessionClient(config, identity.handle, opts.token);
      const result = await client.getEvents(sessionId, {
        ...(opts.after !== undefined ? { afterSequence: opts.after } : {}),
        ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
      });
      if (opts.json) {
        out(JSON.stringify(result, null, 2));
        return;
      }
      if (result.events.length === 0) {
        out("No events.");
        return;
      }
      for (const event of result.events) {
        out(formatEvent(event));
      }
      if (result.next_cursor !== undefined) {
        out(`\n  next_cursor: ${result.next_cursor}`);
      }
    });
}

interface EventsOpts {
  readonly as?: string;
  readonly after?: number;
  readonly limit?: number;
  readonly token?: string;
  readonly json: boolean;
}

// ── shared helpers ────────────────────────────────────────────────────────────

interface AgentLeafOpts {
  readonly as?: string;
  readonly token?: string;
  readonly json?: boolean;
}

function tokenOption() {
  return new Command().createOption(
    "--token <token>",
    "Override the stored agent bearer token (escape hatch)",
  );
}

function parsePositiveIntArg(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0 || String(n) !== raw.trim()) {
    throw new RobotNetCLIError(`expected a non-negative integer, got "${raw}"`);
  }
  return n;
}

function parseInviteList(raw: string | undefined): readonly string[] | undefined {
  if (raw === undefined) return undefined;
  const handles = raw.split(",").map((h) => h.trim()).filter(Boolean);
  for (const h of handles) assertValidHandle(h);
  return handles;
}

function printSession(session: SessionWire): void {
  const pad = 14;
  out(`  ${"id".padEnd(pad)} ${session.id}`);
  out(`  ${"state".padEnd(pad)} ${session.state}`);
  if (session.topic != null && session.topic.length > 0) {
    out(`  ${"topic".padEnd(pad)} ${session.topic}`);
  }
  out(`  ${"created_at".padEnd(pad)} ${new Date(session.created_at).toISOString()}`);
  if (session.ended_at != null) {
    out(`  ${"ended_at".padEnd(pad)} ${new Date(session.ended_at).toISOString()}`);
  }
  if (session.participants.length > 0) {
    out(`  ${"participants".padEnd(pad)}`);
    for (const p of session.participants) {
      out(`    ${p.handle.padEnd(30)} ${p.status}`);
    }
  }
}

function formatSessionTable(sessions: readonly SessionWire[]): string {
  const headers = ["ID", "STATE", "PARTICIPANTS", "TOPIC"];
  const rows = sessions.map((s) => [
    s.id,
    s.state,
    s.participants.map((p) => p.handle).join(", "),
    s.topic ?? "",
  ]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i]?.length ?? 0)),
  );
  const renderRow = (row: readonly string[]): string =>
    row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  ").trimEnd();
  return [headers, ...rows].map(renderRow).join("\n");
}

function formatEvent(event: UnknownSessionEvent): string {
  const ts = new Date(event.created_at).toISOString();
  return `[${event.sequence}] ${ts}  ${event.type}  ${JSON.stringify(event.payload)}`;
}
