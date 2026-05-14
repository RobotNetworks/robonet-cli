import type { OperatorRepository } from "../storage/repository.js";
import type {
  EnvelopeId,
  Handle,
  MailboxEntryRecord,
  Timestamp,
} from "../storage/types.js";

/** Maximum entries any single `GET /mailbox` request returns. */
export const MAILBOX_MAX_LIMIT = 1000;

/** Default page size when the client omits `limit`. */
export const MAILBOX_DEFAULT_LIMIT = 100;

export interface ListMailboxInput {
  readonly caller: Handle;
  readonly order: "asc" | "desc";
  readonly limit: number;
  readonly unread?: boolean;
  readonly afterCreatedAt?: Timestamp;
  readonly afterEnvelopeId?: EnvelopeId;
}

export interface ListMailboxResult {
  readonly entries: readonly MailboxEntryRecord[];
  readonly nextCursor: { created_at: Timestamp; envelope_id: EnvelopeId } | null;
}

/**
 * Service over `mailbox_entries`. Hands raw records to the route layer
 * which assembles them into push-frame-shaped headers using the envelope
 * row's metadata.
 */
export class MailboxService {
  readonly #repo: OperatorRepository;

  constructor(repo: OperatorRepository) {
    this.#repo = repo;
  }

  list(input: ListMailboxInput): ListMailboxResult {
    const entries = this.#repo.mailbox.list({
      mailboxHandle: input.caller,
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
    // `next_cursor` is the last returned entry's pair when the page hit
    // the limit; null otherwise — the spec's "fewer than limit means end"
    // contract.
    const nextCursor =
      entries.length === input.limit && entries.length > 0
        ? {
            created_at: entries[entries.length - 1]!.createdAtMs,
            envelope_id: entries[entries.length - 1]!.envelopeId,
          }
        : null;
    return { entries, nextCursor };
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
