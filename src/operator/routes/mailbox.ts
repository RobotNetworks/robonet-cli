import { requireAgent } from "../auth.js";
import {
  MAILBOX_DEFAULT_LIMIT,
  MAILBOX_MAX_LIMIT,
  type MailboxService,
} from "../domain/mailbox.js";
import { BadRequestError } from "../errors.js";
import type {
  OperatorRepository,
  EnvelopesRepo,
} from "../storage/repository.js";
import type {
  EnvelopeId,
  EnvelopeRecord,
  MailboxEntryRecord,
} from "../storage/types.js";
import { parseJsonBody, sendJson } from "./json.js";
import type { Router } from "./router.js";

interface MailboxRoutesContext {
  readonly repo: OperatorRepository;
  readonly mailbox: MailboxService;
}

/**
 * Register the `/mailbox` surface on `router`.
 *
 *  - `GET /mailbox` keyset-paginated header listing.
 *  - `POST /mailbox/read` bulk mark-as-read.
 */
export function registerMailboxRoutes(
  router: Router,
  ctx: MailboxRoutesContext,
): void {
  router.add("GET", "/mailbox", (rc) => {
    const caller = requireAgent(rc.req, ctx.repo.agents);

    const order = parseOrder(rc.url);
    const limit = parseLimit(rc.url);
    const unread = parseUnread(rc.url);
    const afterCreatedAt = rc.url.searchParams.get("after_created_at");
    const afterEnvelopeId = rc.url.searchParams.get("after_envelope_id");
    if ((afterCreatedAt === null) !== (afterEnvelopeId === null)) {
      throw new BadRequestError(
        "after_created_at and after_envelope_id must be supplied together",
        "INVALID_QUERY",
      );
    }
    let parsedAfterCreatedAt: number | undefined;
    let parsedAfterEnvelopeId: EnvelopeId | undefined;
    if (afterCreatedAt !== null && afterEnvelopeId !== null) {
      parsedAfterCreatedAt = parsePositiveInt(
        afterCreatedAt,
        "after_created_at",
      );
      parsedAfterEnvelopeId = parseEnvelopeId(afterEnvelopeId, "after_envelope_id");
    }

    const result = ctx.mailbox.list({
      caller: caller.handle,
      order,
      limit,
      ...(unread !== undefined ? { unread } : {}),
      ...(parsedAfterCreatedAt !== undefined
        ? { afterCreatedAt: parsedAfterCreatedAt }
        : {}),
      ...(parsedAfterEnvelopeId !== undefined
        ? { afterEnvelopeId: parsedAfterEnvelopeId }
        : {}),
    });

    sendJson(rc.res, 200, {
      envelope_headers: result.entries.map((entry) =>
        renderHeader(ctx.repo.envelopes, entry),
      ),
      next_cursor: result.nextCursor,
    });
  });

  router.add("POST", "/mailbox/read", async (rc) => {
    const caller = requireAgent(rc.req, ctx.repo.agents);
    const body = await parseJsonBody(rc.req);
    const ids = body.ids;
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new BadRequestError(
        "ids must be a non-empty array",
        "INVALID_REQUEST",
      );
    }
    const validated: EnvelopeId[] = ids.map((id, i) =>
      parseEnvelopeId(id, `ids[${i}]`),
    );
    const read = ctx.mailbox.markRead(caller.handle, validated);
    sendJson(rc.res, 200, { read });
  });
}

function parseOrder(url: URL): "asc" | "desc" {
  const v = url.searchParams.get("order");
  if (v === null) return "asc";
  if (v !== "asc" && v !== "desc") {
    throw new BadRequestError(
      "order must be 'asc' or 'desc'",
      "INVALID_QUERY",
    );
  }
  return v;
}

function parseLimit(url: URL): number {
  const v = url.searchParams.get("limit");
  if (v === null || v.length === 0) return MAILBOX_DEFAULT_LIMIT;
  const n = Number.parseInt(v, 10);
  if (!Number.isInteger(n) || n < 1 || n > MAILBOX_MAX_LIMIT || String(n) !== v) {
    throw new BadRequestError(
      `limit must be an integer between 1 and ${MAILBOX_MAX_LIMIT}`,
      "INVALID_QUERY",
    );
  }
  return n;
}

function parseUnread(url: URL): boolean | undefined {
  const v = url.searchParams.get("unread");
  if (v === null) return undefined;
  if (v === "true") return true;
  if (v === "false") return false;
  throw new BadRequestError(
    "unread must be 'true' or 'false'",
    "INVALID_QUERY",
  );
}

function parsePositiveInt(raw: string, field: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 0 || String(n) !== raw) {
    throw new BadRequestError(
      `${field} must be a non-negative integer`,
      "INVALID_QUERY",
    );
  }
  return n;
}

const ENVELOPE_ID_RE = /^01[0-9A-HJKMNP-TV-Z]{24}$/;

function parseEnvelopeId(raw: unknown, field: string): EnvelopeId {
  if (typeof raw !== "string" || !ENVELOPE_ID_RE.test(raw)) {
    throw new BadRequestError(
      `${field} must be a 26-char Crockford-base32 ULID`,
      "INVALID_ENVELOPE_ID",
    );
  }
  return raw;
}

function renderHeader(
  envelopes: EnvelopesRepo,
  entry: MailboxEntryRecord,
): Readonly<Record<string, unknown>> {
  const envelope = envelopes.byId(entry.envelopeId);
  if (envelope === null) {
    // The mailbox entry FKs into envelopes(id) so this is unreachable
    // outside a torn DB.
    throw new Error(
      `internal: mailbox row references missing envelope ${entry.envelopeId}`,
    );
  }
  return buildPushFrame(envelope);
}

function buildPushFrame(
  envelope: EnvelopeRecord,
): Readonly<Record<string, unknown>> {
  // Re-derive the header from the canonical envelope row plus the
  // per-recipient `to`/`cc` lists captured at insert time. The body JSON
  // already has those fields verbatim.
  const body = JSON.parse(envelope.bodyJson) as Record<string, unknown>;
  const frame: Record<string, unknown> = {
    op: "envelope.notify",
    id: envelope.id,
    from: envelope.fromHandle,
    to: body.to,
    type_hint: envelope.typeHint,
    created_at: envelope.createdAtMs,
    date_ms: envelope.dateMs,
  };
  if (body.cc !== undefined) frame.cc = body.cc;
  if (envelope.subject !== null) frame.subject = envelope.subject;
  if (envelope.inReplyTo !== null) frame.in_reply_to = envelope.inReplyTo;
  if (envelope.sizeHint !== null) frame.size_hint = envelope.sizeHint;
  return frame;
}
