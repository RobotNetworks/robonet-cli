import { requireAgent } from "../auth.js";
import {
  MAILBOX_DEFAULT_LIMIT,
  MAILBOX_MAX_LIMIT,
  type MailboxDirection,
  type MailboxItemDirection,
  type MailboxListItem,
  type MailboxService,
} from "../domain/mailbox.js";
import { BadRequestError } from "../errors.js";
import type { OperatorRepository } from "../storage/repository.js";
import type { EnvelopeId } from "../storage/types.js";
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

    const direction = parseDirection(rc.url);
    const order = parseOrder(rc.url);
    const limit = parseLimit(rc.url);
    const unread = parseUnread(rc.url);
    if (unread === true && direction !== "in") {
      throw new BadRequestError(
        "unread=true is only meaningful with direction=in (recipient feed)",
        "INVALID_QUERY",
      );
    }
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
      direction,
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
      envelope_headers: result.items.map((item) =>
        renderHeader(item, direction),
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

function parseDirection(url: URL): MailboxDirection {
  const v = url.searchParams.get("direction");
  if (v === null) return "in";
  if (v !== "in" && v !== "out" && v !== "both") {
    throw new BadRequestError(
      "direction must be 'in', 'out', or 'both'",
      "INVALID_QUERY",
    );
  }
  return v;
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
  item: MailboxListItem,
  requestedDirection: MailboxDirection,
): Readonly<Record<string, unknown>> {
  // Build the push-frame-shaped header from the envelope row plus the
  // per-recipient `to`/`cc` lists captured in the body JSON at insert.
  const envelope = item.envelope;
  const body = JSON.parse(envelope.bodyJson) as Record<string, unknown>;
  const frame: Record<string, unknown> = {
    op: "envelope.notify",
    id: envelope.id,
    from: envelope.fromHandle,
    to: body.to,
    type_hint: envelope.typeHint,
    created_at: item.createdAtMs,
    date_ms: envelope.dateMs,
  };
  if (body.cc !== undefined) frame.cc = body.cc;
  if (envelope.subject !== null) frame.subject = envelope.subject;
  if (envelope.inReplyTo !== null) frame.in_reply_to = envelope.inReplyTo;
  if (envelope.sizeHint !== null) frame.size_hint = envelope.sizeHint;
  // Operator-extension fields:
  //   - ``direction``: stamped on out/both feeds so clients can render
  //     the caller's relationship; omitted on the spec wire ``in`` feed
  //     to keep that response byte-compatible with the ASMTP spec.
  //   - ``unread``: per-recipient read state. Omitted on the spec
  //     wire ``in`` feed (clients use the ``unread=true`` filter
  //     instead); surfaced on ``out``/``both`` for richer admin UX.
  if (requestedDirection !== "in") {
    frame.direction = item.direction satisfies MailboxItemDirection;
    if (item.unread !== null) frame.unread = item.unread;
  }
  return frame;
}
