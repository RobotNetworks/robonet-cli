import { requireAgent } from "../auth.js";
import type { EnvelopeService } from "../domain/envelopes.js";
import { BadRequestError } from "../errors.js";
import { assertHandle } from "../handles.js";
import type { OperatorRepository } from "../storage/repository.js";
import type { EnvelopeId, Handle } from "../storage/types.js";
import { parseJsonBody, sendJson } from "./json.js";
import type { Router } from "./router.js";

interface MessagesRoutesContext {
  readonly repo: OperatorRepository;
  /**
   * The envelope service owns file_id resolution + the single-use
   * claim discipline (see :class:`EnvelopeService.accept`). The route
   * layer no longer touches file content parts — it forwards them
   * verbatim and the service walks them inside its accept transaction.
   */
  readonly envelopes: EnvelopeService;
}

const MAX_BATCH_IDS = 100;

/**
 * Register the `/messages` surface on `router`.
 *
 *  - `POST /messages` accept an envelope, fan out push frames.
 *  - `GET /messages/{id}` fetch one envelope body; marks read.
 *  - `GET /messages?ids=...` batch fetch; marks each returned body read,
 *    silently omits ids the caller isn't entitled to see.
 */
export function registerMessagesRoutes(
  router: Router,
  ctx: MessagesRoutesContext,
): void {
  router.add("POST", "/messages", async (rc) => {
    const sender = requireAgent(rc.req, ctx.repo.agents);
    const body = await parseJsonBody(rc.req);
    if ("from" in body) {
      throw new BadRequestError(
        "client must not supply `from`; operator stamps it",
        "INVALID_REQUEST",
      );
    }
    const id = parseEnvelopeIdField(body.id, "id");
    const to = parseHandleArray(body.to, "to");
    const cc = body.cc !== undefined ? parseHandleArray(body.cc, "cc") : undefined;
    const subject = parseOptionalString(body.subject, "subject");
    const inReplyTo =
      body.in_reply_to !== undefined
        ? parseEnvelopeIdField(body.in_reply_to, "in_reply_to")
        : undefined;
    const references =
      body.references !== undefined
        ? parseEnvelopeIdArray(body.references, "references")
        : undefined;
    const dateMs = parseRequiredTimestamp(body.date_ms, "date_ms");
    const contentParts = parseContentParts(body.content_parts);
    const monitor = parseOptionalString(body.monitor, "monitor");

    const now = Date.now();
    const result = ctx.envelopes.accept({
      id,
      from: sender.handle,
      to,
      ...(cc !== undefined ? { cc } : {}),
      ...(subject !== undefined ? { subject } : {}),
      ...(inReplyTo !== undefined ? { inReplyTo } : {}),
      ...(references !== undefined ? { references } : {}),
      dateMs,
      contentParts,
      ...(monitor !== undefined ? { monitor } : {}),
      receivedMs: now,
      createdAtMs: now,
    });

    sendJson(rc.res, 202, {
      id: result.id,
      received_ms: result.receivedMs,
      created_at: result.createdAtMs,
      recipients: result.recipients.map((handle) => ({ handle })),
    });
  });

  router.add("GET", "/messages", (rc) => {
    const caller = requireAgent(rc.req, ctx.repo.agents);
    const raw = rc.url.searchParams.get("ids");
    if (raw === null || raw.length === 0) {
      throw new BadRequestError("ids parameter is required", "INVALID_QUERY");
    }
    // Reject repeated `?ids=` parameters per spec — operators
    // distinguish a single comma-separated string from the array form.
    if (rc.url.searchParams.getAll("ids").length !== 1) {
      throw new BadRequestError(
        "ids must be supplied as a single comma-separated parameter",
        "INVALID_QUERY",
      );
    }
    const ids = raw.split(",");
    if (ids.length > MAX_BATCH_IDS) {
      throw new BadRequestError(
        `ids list exceeds ${MAX_BATCH_IDS}`,
        "INVALID_QUERY",
      );
    }
    const validated: EnvelopeId[] = ids.map((id, i) =>
      parseEnvelopeIdField(id, `ids[${i}]`),
    );
    const envelopes = ctx.envelopes.fetchMany(caller.handle, validated);
    const envelope_bodies = envelopes.map((e) =>
      JSON.parse(e.bodyJson) as Record<string, unknown>,
    );
    sendJson(rc.res, 200, { envelopes: envelope_bodies });
  });

  router.add("GET", "/messages/:id", (rc) => {
    const caller = requireAgent(rc.req, ctx.repo.agents);
    const id = parseEnvelopeIdField(rc.params.id, "id");
    const envelope = ctx.envelopes.fetchOne(caller.handle, id);
    rc.res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(envelope.bodyJson),
    });
    rc.res.end(envelope.bodyJson);
  });
}

const ENVELOPE_ID_RE = /^01[0-9A-HJKMNP-TV-Z]{24}$/;

function parseEnvelopeIdField(value: unknown, field: string): EnvelopeId {
  if (typeof value !== "string" || !ENVELOPE_ID_RE.test(value)) {
    throw new BadRequestError(
      `${field} must be a 26-char Crockford-base32 ULID`,
      "INVALID_ENVELOPE_ID",
    );
  }
  return value;
}

function parseEnvelopeIdArray(
  raw: unknown,
  field: string,
): readonly EnvelopeId[] {
  if (!Array.isArray(raw)) {
    throw new BadRequestError(`${field} must be an array`, "INVALID_REQUEST");
  }
  return raw.map((v, i) => parseEnvelopeIdField(v, `${field}[${i}]`));
}

function parseHandleArray(raw: unknown, field: string): readonly Handle[] {
  if (!Array.isArray(raw)) {
    throw new BadRequestError(`${field} must be an array of handles`, "INVALID_REQUEST");
  }
  if (raw.length === 0) {
    throw new BadRequestError(`${field} must contain at least one handle`, "INVALID_REQUEST");
  }
  return raw.map((h, i) => assertHandle(h, `${field}[${i}]`));
}

function parseOptionalString(raw: unknown, field: string): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    throw new BadRequestError(`${field} must be a string`, "INVALID_REQUEST");
  }
  return raw;
}

function parseRequiredTimestamp(raw: unknown, field: string): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    throw new BadRequestError(
      `${field} must be a non-negative integer (epoch ms)`,
      "INVALID_REQUEST",
    );
  }
  return raw;
}

function parseContentParts(raw: unknown): readonly unknown[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new BadRequestError(
      "content_parts must be a non-empty array",
      "INVALID_CONTENT",
    );
  }
  for (let i = 0; i < raw.length; i++) {
    const part = raw[i];
    if (typeof part !== "object" || part === null || Array.isArray(part)) {
      throw new BadRequestError(
        `content_parts[${i}] must be an object`,
        "INVALID_CONTENT",
      );
    }
    const obj = part as Record<string, unknown>;
    const type = obj.type;
    if (
      type !== "text" &&
      type !== "image" &&
      type !== "file" &&
      type !== "data"
    ) {
      throw new BadRequestError(
        `content_parts[${i}].type must be one of text/image/file/data`,
        "INVALID_CONTENT",
      );
    }
    if (type === "text") {
      if (typeof obj.text !== "string" || obj.text.length === 0) {
        throw new BadRequestError(
          `content_parts[${i}].text must be a non-empty string`,
          "INVALID_CONTENT",
        );
      }
    } else if (type === "image" || type === "file") {
      const hasUrl = typeof obj.url === "string" && obj.url.length > 0;
      const hasFileId =
        typeof obj.file_id === "string" && obj.file_id.length > 0;
      if (!hasUrl && !hasFileId) {
        throw new BadRequestError(
          `content_parts[${i}] requires either 'url' or 'file_id'`,
          "INVALID_CONTENT",
        );
      }
      if (hasUrl && hasFileId) {
        throw new BadRequestError(
          `content_parts[${i}] cannot set both 'url' and 'file_id'`,
          "INVALID_CONTENT",
        );
      }
      if (hasUrl && (obj.url as string).startsWith("data:")) {
        throw new BadRequestError(
          `content_parts[${i}].url MUST NOT use the data: scheme`,
          "INVALID_CONTENT",
        );
      }
    } else if (type === "data") {
      if (
        typeof obj.data !== "object" ||
        obj.data === null ||
        Array.isArray(obj.data)
      ) {
        throw new BadRequestError(
          `content_parts[${i}].data must be a JSON object`,
          "INVALID_CONTENT",
        );
      }
    }
  }
  return raw;
}
