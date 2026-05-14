import * as fs from "node:fs";
import * as path from "node:path";

import { Command } from "commander";

import { resolveAgentBearer } from "../asmtp/auth-resolver.js";
import { FilesClient } from "../asmtp/files-client.js";
import { handleArg, handlesArg } from "../asmtp/handles.js";
import { MessagesClient } from "../asmtp/messages-client.js";
import type {
  ContentPart,
  EnvelopeId,
  EnvelopePost,
  Handle,
} from "../asmtp/types.js";
import { RobotNetCLIError } from "../errors.js";
import {
  loadConfigForAgentCommand,
  out,
  readStringOrFile,
  tokenOption,
} from "./shared.js";

/**
 * `robotnet send` — assemble and send one envelope.
 *
 * Recipients are the variadic positional arg. Content is built from
 * `--text`, `--file`, `--image`, and `--data` flags; each flag is
 * repeatable and parts appear in argument order. `--file` / `--image`
 * upload to `POST /files` and embed the returned URL on the envelope.
 */
export function registerSendCommand(program: Command): void {
  program.addCommand(makeSendCommand());
}

function makeSendCommand(): Command {
  return new Command("send")
    .description("Send an envelope to one or more recipients")
    .argument("<recipients...>", "Recipient handles", handlesArg)
    .option("--as <handle>", "Act as this agent handle", handleArg)
    .option("--subject <text>", "Optional envelope subject")
    .option(
      "--text <body>",
      "Add a text content part (repeatable)",
      collectRepeatable,
      [] as string[],
    )
    .option(
      "--file <path>",
      "Upload <path> and embed it as a file content part (repeatable; content type inferred from extension)",
      collectRepeatable,
      [] as string[],
    )
    .option(
      "--image <path>",
      "Upload <path> and embed it as an image content part (repeatable; content type inferred from extension)",
      collectRepeatable,
      [] as string[],
    )
    .option(
      "--data <json-or-@file>",
      "Add a data content part (inline JSON object literal or @<path>)",
      collectRepeatable,
      [] as string[],
    )
    .option(
      "--in-reply-to <envelope_id>",
      "Mark the envelope as a reply to <envelope_id>",
      envelopeIdArg,
    )
    .option(
      "--monitor <handle>",
      "Opt into sender-side monitor facts under this handle (mon_…)",
      monitorHandleArg,
    )
    .addOption(tokenOption())
    .option("--json", "Emit machine-readable JSON", false)
    .action(async (recipients: Handle[], opts: SendOpts, cmd: Command) => {
      const { config, identity } = await loadConfigForAgentCommand(cmd, opts.as);
      const { token, baseUrl } = await resolveAgentBearer(
        config,
        identity.handle,
        opts.token,
      );
      const contentParts = await buildContent(opts, baseUrl, token);
      if (contentParts.length === 0) {
        throw new RobotNetCLIError(
          "send needs at least one content part. Pass --text, --file, --image, or --data.",
        );
      }
      const envelope: EnvelopePost = {
        id: mintEnvelopeId(),
        to: recipients,
        date_ms: Date.now(),
        content_parts: contentParts,
        ...(opts.subject !== undefined ? { subject: opts.subject } : {}),
        ...(opts.inReplyTo !== undefined ? { in_reply_to: opts.inReplyTo } : {}),
        ...(opts.monitor !== undefined ? { monitor: opts.monitor } : {}),
      };
      const client = new MessagesClient(baseUrl, token);
      const result = await client.send(envelope);
      if (opts.json) {
        out(JSON.stringify(result, null, 2));
        return;
      }
      out(`Sent envelope ${result.id}.`);
      out(`  received_ms: ${result.received_ms}`);
      out(`  created_at:  ${result.created_at}`);
      if (result.recipients.length > 0) {
        out(`  recipients:  ${result.recipients.map((r) => r.handle).join(", ")}`);
      }
    });
}

interface SendOpts {
  readonly as?: string;
  readonly token?: string;
  readonly subject?: string;
  readonly text: string[];
  readonly file: string[];
  readonly image: string[];
  readonly data: string[];
  readonly inReplyTo?: EnvelopeId;
  readonly monitor?: string;
  readonly json: boolean;
}

function collectRepeatable(value: string, prev: string[]): string[] {
  return [...prev, value];
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

const MONITOR_HANDLE_RE = /^mon_[0-9A-Za-z_-]{1,64}$/;
function monitorHandleArg(value: string): string {
  if (!MONITOR_HANDLE_RE.test(value)) {
    throw new RobotNetCLIError(
      `invalid monitor handle ${JSON.stringify(value)}; expected mon_<token>`,
    );
  }
  return value;
}

/**
 * Mint a fresh sender-allocated envelope id. ULID layout: 48-bit
 * milliseconds in the high 10 chars + 80 bits of randomness in the low 16.
 * Crockford base32 — characters I, L, O, U are excluded by the
 * 32-character alphabet.
 */
function mintEnvelopeId(): EnvelopeId {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const now = Date.now();
  let timePart = "";
  let v = now;
  for (let i = 0; i < 10; i++) {
    timePart = alphabet[v % 32] + timePart;
    v = Math.floor(v / 32);
  }
  const rnd = new Uint8Array(10);
  for (let i = 0; i < rnd.length; i++) rnd[i] = Math.floor(Math.random() * 256);
  let bits = 0;
  let buf = 0;
  let randPart = "";
  for (const byte of rnd) {
    buf = (buf << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      randPart += alphabet[(buf >>> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    randPart += alphabet[(buf << (5 - bits)) & 0x1f];
  }
  return (timePart + randPart).slice(0, 26);
}

async function buildContent(
  opts: SendOpts,
  baseUrl: string,
  token: string,
): Promise<ContentPart[]> {
  const parts: ContentPart[] = [];

  for (const t of opts.text) {
    if (t.length === 0) {
      throw new RobotNetCLIError("--text values must be non-empty");
    }
    parts.push({ type: "text", text: t });
  }

  const filesClient =
    opts.file.length > 0 || opts.image.length > 0
      ? new FilesClient(baseUrl, token)
      : null;

  for (const filePath of opts.file) {
    const upload = await uploadFile(filesClient!, filePath);
    parts.push({
      type: "file",
      url: upload.url,
      name: path.basename(filePath),
      mime_type: upload.contentType,
      size: upload.size,
    });
  }

  for (const imgPath of opts.image) {
    const upload = await uploadFile(filesClient!, imgPath);
    parts.push({
      type: "image",
      url: upload.url,
      mime_type: upload.contentType,
    });
  }

  for (const literal of opts.data) {
    parts.push({ type: "data", data: parseDataLiteral(literal) });
  }

  return parts;
}

interface UploadedFile {
  readonly url: string;
  readonly contentType: string;
  readonly size: number;
}

async function uploadFile(
  client: FilesClient,
  filePath: string,
): Promise<UploadedFile> {
  let bytes: Uint8Array;
  try {
    bytes = await fs.promises.readFile(filePath);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new RobotNetCLIError(`Could not read ${filePath}: ${detail}`);
  }
  const filename = path.basename(filePath);
  const contentType = guessContentType(filename);
  const result = await client.upload({ bytes, filename, contentType });
  return { url: result.url, contentType, size: bytes.length };
}

function parseDataLiteral(raw: string): Readonly<Record<string, unknown>> {
  const text = readStringOrFile(raw, "--data");
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
