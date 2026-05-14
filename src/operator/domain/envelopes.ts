import type { DatabaseSync } from "node:sqlite";

import { BadRequestError, ConflictError, NotFoundError } from "../errors.js";
import { assertHandle } from "../handles.js";
import type {
  OperatorRepository,
} from "../storage/repository.js";
import { withTransaction } from "../storage/transaction.js";
import type {
  EnvelopeId,
  EnvelopeRecord,
  Handle,
  Timestamp,
  TypeHint,
} from "../storage/types.js";
import { canInitiate } from "./policy.js";
import type { ConnectionRegistry } from "./transport.js";

/**
 * Validated envelope ready for storage. `from` is operator-stamped from
 * the bearer; `id` / `to` / `content_parts` come from the client.
 */
export interface AcceptEnvelopeInput {
  readonly id: EnvelopeId;
  readonly from: Handle;
  readonly to: readonly Handle[];
  readonly cc?: readonly Handle[];
  readonly subject?: string;
  readonly inReplyTo?: EnvelopeId;
  readonly references?: readonly EnvelopeId[];
  readonly dateMs: Timestamp;
  readonly contentParts: readonly unknown[];
  readonly monitor?: string;
  /** Operator-stamped accept-time clock. */
  readonly receivedMs: Timestamp;
  /** Operator-stamped envelope-level timestamp for mailbox ordering. */
  readonly createdAtMs: Timestamp;
}

export interface AcceptEnvelopeResult {
  readonly id: EnvelopeId;
  readonly receivedMs: Timestamp;
  readonly createdAtMs: Timestamp;
  readonly recipients: readonly Handle[];
}

/** Envelope id syntax (ULID 26 chars, Crockford-base32, no I/L/O/U, leading "01"). */
const ENVELOPE_ID_RE = /^01[0-9A-HJKMNP-TV-Z]{24}$/;

const MONITOR_HANDLE_RE = /^mon_[0-9A-Za-z_-]{1,64}$/;

/**
 * In-tree operator envelope service.
 *
 * Accepts validated envelope inputs, enforces sender allowlist policy
 * (both directions per spec section 6.2 — symmetric reachability), writes
 * the canonical envelope plus a mailbox entry per recipient, and fans out
 * `envelope.notify` push frames over the connection registry.
 *
 * Monitor facts are emitted synchronously per recipient when the sender
 * supplied a `monitor` handle: one `stored` fact per accepted mailbox.
 */
export class EnvelopeService {
  readonly #repo: OperatorRepository;
  readonly #db: DatabaseSync;
  readonly #registry: ConnectionRegistry;

  constructor(
    repo: OperatorRepository,
    db: DatabaseSync,
    registry: ConnectionRegistry,
  ) {
    this.#repo = repo;
    this.#db = db;
    this.#registry = registry;
  }

  /**
   * Accept an envelope, persist it, fan out push frames. The operation
   * is all-or-nothing across recipients: any unreachable recipient
   * (404) or trust denial aborts the entire send without writing any
   * mailbox row.
   */
  accept(input: AcceptEnvelopeInput): AcceptEnvelopeResult {
    if (!ENVELOPE_ID_RE.test(input.id)) {
      throw new BadRequestError(
        `id must be a 26-char Crockford-base32 ULID`,
        "INVALID_ENVELOPE_ID",
      );
    }
    if (input.monitor !== undefined && !MONITOR_HANDLE_RE.test(input.monitor)) {
      throw new BadRequestError(
        `monitor must match mon_<token>`,
        "INVALID_MONITOR",
      );
    }
    if (input.to.length === 0) {
      throw new BadRequestError("to must be a non-empty array", "INVALID_TO");
    }
    if (input.contentParts.length === 0) {
      throw new BadRequestError(
        "content_parts must contain at least one part",
        "INVALID_CONTENT",
      );
    }
    if (
      input.references !== undefined &&
      input.references.length > 0 &&
      input.inReplyTo !== undefined &&
      input.references[input.references.length - 1] !== input.inReplyTo
    ) {
      throw new BadRequestError(
        "references[-1] must equal in_reply_to when both are present",
        "INVALID_REFERENCES",
      );
    }
    const from = assertHandle(input.from, "from");
    const allRecipients = uniquePreserveOrder([
      ...input.to.map((h) => assertHandle(h, "to[]")),
      ...(input.cc ?? []).map((h) => assertHandle(h, "cc[]")),
    ]);

    const typeHint = computeTypeHint(input.contentParts);
    const sizeHint = estimateTokens(input.contentParts);
    const bodyJson = buildBodyJson(from, input);

    const dispatches = withTransaction(this.#db, () => {
      // Evaluate recipient existence + trust policy + blocks first per
      // spec ordering: 404 cases must surface before 409 same-id retry
      // collisions, so a bad id can't probe whether a new recipient is
      // reachable.
      for (const target of allRecipients) {
        if (!canInitiate(this.#repo, from, target)) {
          throw new NotFoundError("not found");
        }
        if (this.#repo.blocks.isBlocked(target, from)) {
          throw new NotFoundError("not found");
        }
      }

      // Same-sender retry idempotency: a second POST with the same id
      // from the same sender returns the original envelope if its body
      // matches; conflicts (409) otherwise. Cross-sender duplicates also
      // 409 (id collision).
      const existing = this.#repo.envelopes.byId(input.id);
      if (existing !== null) {
        if (existing.fromHandle !== from) {
          throw new ConflictError(
            "envelope id already exists for a different sender",
            "ID_COLLISION",
          );
        }
        if (existing.bodyJson !== bodyJson) {
          throw new ConflictError(
            "envelope id already used with a different body",
            "RETRY_MISMATCH",
          );
        }
        // Replay match — return the original 202 shape, no fan-out.
        return [] as readonly Dispatch[];
      }

      this.#repo.envelopes.insert({
        id: input.id,
        fromHandle: from,
        subject: input.subject ?? null,
        inReplyTo: input.inReplyTo ?? null,
        dateMs: input.dateMs,
        receivedMs: input.receivedMs,
        createdAtMs: input.createdAtMs,
        typeHint,
        sizeHint,
        monitorHandle: input.monitor ?? null,
        bodyJson,
      });

      const toSet = new Set(input.to);
      for (const recipient of allRecipients) {
        this.#repo.mailbox.insert({
          mailboxHandle: recipient,
          envelopeId: input.id,
          kind: toSet.has(recipient) ? "to" : "cc",
          createdAtMs: input.createdAtMs,
        });
      }

      // Build push frames for fan-out after commit.
      const pushFrame = buildPushFrame({
        id: input.id,
        from,
        to: input.to,
        ...(input.cc !== undefined && input.cc.length > 0
          ? { cc: input.cc }
          : {}),
        ...(input.subject !== undefined ? { subject: input.subject } : {}),
        ...(input.inReplyTo !== undefined
          ? { in_reply_to: input.inReplyTo }
          : {}),
        type_hint: typeHint,
        size_hint: sizeHint,
        created_at: input.createdAtMs,
        date_ms: input.dateMs,
      });
      const dispatches: Dispatch[] = allRecipients.map((handle) => ({
        handle,
        payload: pushFrame,
      }));
      // Monitor fan-out to the sender if requested: emit one
      // `stored` fact per recipient over the sender's WS.
      if (input.monitor !== undefined) {
        for (const recipient of allRecipients) {
          dispatches.push({
            handle: from,
            payload: JSON.stringify({
              op: "monitor.fact",
              monitor: input.monitor,
              envelope_id: input.id,
              recipient_handle: recipient,
              fact: "stored",
              at_ms: input.createdAtMs,
            }),
          });
        }
      }
      return dispatches;
    });

    for (const d of dispatches) {
      this.#registry.send(d.handle, d.payload);
    }

    return {
      id: input.id,
      receivedMs: input.receivedMs,
      createdAtMs: input.createdAtMs,
      recipients: allRecipients,
    };
  }

  /**
   * Resolve `GET /messages/{id}` for `caller`. Returns the canonical
   * envelope body; non-recipients receive 404 (non-enumerating). Marks
   * the entry read for the caller as a side effect.
   */
  fetchOne(caller: Handle, id: EnvelopeId): EnvelopeRecord {
    const entry = this.#repo.mailbox.get(caller, id);
    if (entry === null) {
      throw new NotFoundError("not found");
    }
    const envelope = this.#repo.envelopes.byId(id);
    if (envelope === null) {
      throw new NotFoundError("not found");
    }
    this.#repo.mailbox.markRead(caller, [id]);
    return envelope;
  }

  /**
   * Batch fetch — unentitled ids are silently omitted; duplicates in the
   * request are deduped server-side. The response orders by first
   * occurrence in the input `ids` array (after dedup). Marks each
   * returned envelope read for the caller.
   */
  fetchMany(caller: Handle, ids: readonly EnvelopeId[]): readonly EnvelopeRecord[] {
    const deduped: EnvelopeId[] = [];
    const seen = new Set<EnvelopeId>();
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      deduped.push(id);
    }
    const entitled = deduped.filter(
      (id) => this.#repo.mailbox.get(caller, id) !== null,
    );
    const envelopes = this.#repo.envelopes.byIds(entitled);
    if (envelopes.length > 0) {
      this.#repo.mailbox.markRead(
        caller,
        envelopes.map((e) => e.id),
      );
    }
    return envelopes;
  }
}

interface Dispatch {
  readonly handle: Handle;
  readonly payload: string;
}

/** Strip duplicates from `xs` while preserving first-occurrence order. */
function uniquePreserveOrder<T>(xs: readonly T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const x of xs) {
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

function computeTypeHint(parts: readonly unknown[]): TypeHint {
  const types = new Set<string>();
  for (const part of parts) {
    if (typeof part !== "object" || part === null) continue;
    const t = (part as { type?: unknown }).type;
    if (typeof t === "string") types.add(t);
  }
  if (types.size === 1) {
    const only = [...types][0];
    if (only === "text" || only === "image" || only === "file" || only === "data") {
      return only;
    }
  }
  return "mixed";
}

/**
 * Operator-side `size_hint` estimate. Counts the envelope JSON size in
 * approximate tokens (~4 chars per token), capped at the schema minimum
 * of 0. Advisory; cross-tokenizer variance is acceptable per spec.
 */
function estimateTokens(parts: readonly unknown[]): number {
  const json = JSON.stringify(parts);
  return Math.max(0, Math.ceil(json.length / 4));
}

/**
 * Serialise the canonical envelope (with operator-stamped `from`) for
 * storage in `envelopes.body_json`. This is the exact body returned by
 * `GET /messages/{id}`.
 */
function buildBodyJson(from: Handle, input: AcceptEnvelopeInput): string {
  const body: Record<string, unknown> = {
    id: input.id,
    from,
    to: [...input.to],
    date_ms: input.dateMs,
    content_parts: input.contentParts,
  };
  if (input.cc !== undefined && input.cc.length > 0) body.cc = [...input.cc];
  if (input.subject !== undefined) body.subject = input.subject;
  if (input.inReplyTo !== undefined) body.in_reply_to = input.inReplyTo;
  if (input.references !== undefined && input.references.length > 0) {
    body.references = [...input.references];
  }
  if (input.monitor !== undefined) body.monitor = input.monitor;
  return JSON.stringify(body);
}

/** Build a push frame payload (already JSON-encoded). */
function buildPushFrame(frame: Record<string, unknown>): string {
  return JSON.stringify({ op: "envelope.notify", ...frame });
}
