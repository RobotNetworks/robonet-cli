/**
 * File upload + download routes for the in-tree operator.
 *
 *  - `POST /files` multipart/form-data upload, single `file` field,
 *    bearer-auth. Returns upload metadata keyed by an opaque `id`; the
 *    sender embeds `{type:"file"|"image", file_id}` on a content part
 *    and the operator resolves to a `url` at envelope-accept time. The
 *    accept step ALSO claims the file row to the envelope (single-use
 *    binding) — see `../domain/envelopes.ts` for the transaction.
 *  - `GET /files/:id` bearer-auth; streams the bytes. Authorization:
 *    caller is the uploader OR caller is a party (sender, To, Cc) to
 *    the envelope the file is attached to. Returns 404 — never 403 —
 *    for non-matches (non-enumerating). Pending files (no envelope
 *    binding yet) are uploader-only.
 */

import { requireAgent } from "../auth.js";
import type { FileService } from "../domain/files.js";
import { BadRequestError, NotFoundError } from "../errors.js";
import type { OperatorRepository } from "../storage/repository.js";
import { sendJson } from "./json.js";
import type { Router } from "./router.js";

interface FileRoutesContext {
  readonly repo: OperatorRepository;
  readonly files: FileService;
}

export function registerFileRoutes(
  router: Router,
  ctx: FileRoutesContext,
): void {
  router.add("POST", "/files", async (rc) => {
    const agent = requireAgent(rc.req, ctx.repo.agents);

    const contentType = rc.req.headers["content-type"];
    if (typeof contentType !== "string") {
      throw new BadRequestError(
        "Content-Type header is required (multipart/form-data)",
        "INVALID_REQUEST",
      );
    }
    if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
      throw new BadRequestError(
        "Content-Type must be multipart/form-data",
        "INVALID_REQUEST",
      );
    }
    const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    const boundary = boundaryMatch
      ? (boundaryMatch[1] ?? boundaryMatch[2] ?? "").trim()
      : "";
    if (boundary.length === 0) {
      throw new BadRequestError(
        "Content-Type missing 'boundary' parameter",
        "INVALID_REQUEST",
      );
    }

    const body = await readBody(rc.req);
    const part = parseSingleMultipartFile(body, boundary);

    const result = ctx.files.upload({
      ownerHandle: agent.handle,
      filename: part.filename,
      contentType: part.contentType,
      bytes: part.bytes,
    });

    sendJson(rc.res, 201, {
      id: result.id,
      status: result.status,
      filename: result.filename,
      content_type: result.contentType,
      size_bytes: result.sizeBytes,
      created_at: result.createdAt,
      expires_at: result.expiresAt,
    });
  });

  router.add("GET", "/files/:id", (rc) => {
    const agent = requireAgent(rc.req, ctx.repo.agents);
    const id = rc.params.id;
    const fileRow = ctx.repo.files.byId(id);
    if (fileRow === null) {
      throw new NotFoundError("not found");
    }
    if (!callerCanFetchFile(ctx.repo, agent.handle, fileRow)) {
      // Non-enumerating: same 404 the missing-row branch returns.
      throw new NotFoundError("not found");
    }
    const served = ctx.files.serveById(id);
    rc.res.statusCode = 200;
    rc.res.setHeader("Content-Type", served.row.contentType);
    rc.res.setHeader("Content-Length", String(served.bytes.length));
    rc.res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeFilename(served.row.filename)}"`,
    );
    rc.res.end(served.bytes);
  });
}


/**
 * Visibility predicate for `GET /files/:id`. True when the caller is
 * the uploader OR is a party (sender, To, Cc) of the envelope the file
 * is attached to. Pending files (`attachedToEnvelopeId === null`) are
 * uploader-only — exposing them would skip the claim discipline.
 */
function callerCanFetchFile(
  repo: OperatorRepository,
  callerHandle: string,
  fileRow: { ownerHandle: string; attachedToEnvelopeId: string | null },
): boolean {
  if (fileRow.ownerHandle === callerHandle) return true;
  if (fileRow.attachedToEnvelopeId === null) return false;
  const entry = repo.mailbox.get(callerHandle, fileRow.attachedToEnvelopeId);
  if (entry !== null) return true;
  // Sender-side party: caller is not in mailbox_entries but is the
  // envelope's `from_handle`. The wire-spec entitlement on fetch is
  // "any party to the envelope" — sender included.
  const envelope = repo.envelopes.byId(fileRow.attachedToEnvelopeId);
  return envelope !== null && envelope.fromHandle === callerHandle;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function readBody(req: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer | string) => {
      chunks.push(typeof c === "string" ? Buffer.from(c) : c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

interface MultipartFilePart {
  readonly filename: string;
  readonly contentType: string;
  readonly bytes: Buffer;
}

/**
 * Minimal multipart/form-data parser — extracts a single `file` field
 * with a Content-Disposition filename and Content-Type header. Rejects
 * any other field shape with a 400.
 */
function parseSingleMultipartFile(
  body: Buffer,
  boundary: string,
): MultipartFilePart {
  const open = Buffer.from(`--${boundary}\r\n`);
  const sep = Buffer.from(`\r\n--${boundary}`);
  const start = body.indexOf(open);
  if (start === -1) {
    throw new BadRequestError(
      "multipart: opening boundary not found",
      "INVALID_REQUEST",
    );
  }
  const headersStart = start + open.length;
  const partEnd = body.indexOf(sep, headersStart);
  if (partEnd === -1) {
    throw new BadRequestError(
      "multipart: closing boundary not found",
      "INVALID_REQUEST",
    );
  }
  const headerBlockEnd = body.indexOf(Buffer.from("\r\n\r\n"), headersStart);
  if (headerBlockEnd === -1 || headerBlockEnd >= partEnd) {
    throw new BadRequestError(
      "multipart: malformed headers",
      "INVALID_REQUEST",
    );
  }
  const headerText = body.slice(headersStart, headerBlockEnd).toString("utf8");
  const bytes = body.slice(headerBlockEnd + 4, partEnd);

  let fieldName: string | null = null;
  let filename: string | null = null;
  let contentType: string | null = null;
  for (const line of headerText.split("\r\n")) {
    if (line.length === 0) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (name === "content-disposition") {
      const nameMatch = value.match(/\bname="([^"]+)"/);
      const fileMatch = value.match(/\bfilename="([^"]+)"/);
      if (nameMatch !== null) fieldName = nameMatch[1] ?? null;
      if (fileMatch !== null) filename = fileMatch[1] ?? null;
    } else if (name === "content-type") {
      contentType = value;
    }
  }

  if (fieldName !== "file") {
    throw new BadRequestError(
      "multipart: expected a single 'file' field",
      "INVALID_REQUEST",
    );
  }
  if (filename === null || filename.length === 0) {
    throw new BadRequestError(
      "multipart: 'file' field is missing a filename",
      "INVALID_REQUEST",
    );
  }
  if (contentType === null || contentType.length === 0) {
    throw new BadRequestError(
      "multipart: 'file' field is missing a Content-Type",
      "INVALID_REQUEST",
    );
  }
  return { filename, contentType, bytes };
}

function encodeFilename(name: string): string {
  return name.replace(/"/g, "");
}
