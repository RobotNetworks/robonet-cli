import type { OperatorRepository } from "../storage/repository.js";
import type {
  EnvelopeId,
  EnvelopeRecord,
  Handle,
  Timestamp,
} from "../storage/types.js";

/** Maximum entries any single `GET /mailbox` request returns. */
export const MAILBOX_MAX_LIMIT = 1000;

/** Default page size when the client omits `limit`. */
export const MAILBOX_DEFAULT_LIMIT = 100;

/**
 * `in` (default) is the spec wire feed — envelopes addressed to the
 * caller. `out` and `both` are operator extensions exposed through the
 * same route via the ``direction`` query param.
 */
export type MailboxDirection = "in" | "out" | "both";

/** Caller's relationship to a returned envelope. ``self`` only appears
 *  in the ``both`` feed when the caller sent to themselves. */
export type MailboxItemDirection = "in" | "out" | "self";

export interface ListMailboxInput {
  readonly caller: Handle;
  readonly direction: MailboxDirection;
  readonly order: "asc" | "desc";
  readonly limit: number;
  readonly unread?: boolean;
  readonly afterCreatedAt?: Timestamp;
  readonly afterEnvelopeId?: EnvelopeId;
}

export interface MailboxListItem {
  readonly envelope: EnvelopeRecord;
  /** Operator-stamped acceptance timestamp. For ``in`` rows this is the
   *  recipient's ``mailbox_entries.created_at_ms``; for ``out`` rows it
   *  is the envelope's ``created_at_ms``. The two are stamped from the
   *  same ``now_ms()`` at insert. */
  readonly createdAtMs: Timestamp;
  readonly direction: MailboxItemDirection;
  /** Recipient-side read flag. ``null`` when the caller is sender-only
   *  on this envelope (``out`` rows in ``direction=both`` for non-self
   *  sends). */
  readonly unread: boolean | null;
}

export interface ListMailboxResult {
  readonly items: readonly MailboxListItem[];
  readonly nextCursor: { created_at: Timestamp; envelope_id: EnvelopeId } | null;
}

/**
 * Service over the mailbox surface. Branches on ``direction``:
 *   - ``in``: rows from ``mailbox_entries`` (recipient feed; spec).
 *   - ``out``: rows from ``envelopes`` where ``from_handle = caller``.
 *   - ``both``: union, with ``self`` direction stamped on self-sends.
 */
export class MailboxService {
  readonly #repo: OperatorRepository;

  constructor(repo: OperatorRepository) {
    this.#repo = repo;
  }

  list(input: ListMailboxInput): ListMailboxResult {
    if (input.unread === true && input.direction !== "in") {
      // Server-side echo of the CLI's client-side check — read state is
      // per-recipient and has no sender-side meaning.
      throw new Error(
        "unread=true is only meaningful with direction=in (recipient feed)",
      );
    }
    const items = this.#repo.mailbox.listForCaller({
      caller: input.caller,
      direction: input.direction,
      order: input.order,
      limit: input.limit,
      ...(input.unread !== undefined ? { unread: input.unread } : {}),
      ...(input.afterCreatedAt !== undefined
        ? { afterCreatedAt: input.afterCreatedAt }
        : {}),
      ...(input.afterEnvelopeId !== undefined
        ? { afterEnvelopeId: input.afterEnvelopeId }
        : {}),
    });
    const nextCursor =
      items.length === input.limit && items.length > 0
        ? {
            created_at: items[items.length - 1]!.createdAtMs,
            envelope_id: items[items.length - 1]!.envelope.id,
          }
        : null;
    return { items, nextCursor };
  }

  /**
   * Mark `ids` read for the caller. Returns the ids actually transitioned
   * — already-read ids are silently skipped; ids the caller does not own
   * are dropped (non-enumerating).
   */
  markRead(caller: Handle, ids: readonly EnvelopeId[]): readonly EnvelopeId[] {
    return this.#repo.mailbox.markRead(caller, ids);
  }
}
