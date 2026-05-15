import { asmtpRequest } from "./http.js";
import type {
  EnvelopeId,
  GetMailboxResponse,
  MailboxCursor,
  PostReadResponse,
} from "./types.js";

export type MailboxOrder = "asc" | "desc";

/** Filter on the mailbox listing. `in` (default) is the spec-conformant
 *  recipient feed; `out` and `both` are operator extensions that surface
 *  the sender side and the union respectively. Operators that don't
 *  implement the extension silently return the `in` feed. */
export type MailboxDirection = "in" | "out" | "both";

export interface ListMailboxOptions {
  /** Order entries oldest-first (`asc`, default) or newest-first (`desc`). */
  readonly order?: MailboxOrder;
  /** Maximum entries to return. Operator caps at 1000. */
  readonly limit?: number;
  /** Restrict to unread entries when true. */
  readonly unread?: boolean;
  /**
   * Cursor pair from a prior response's `next_cursor`. Both halves must be
   * supplied together; sending exactly one returns 400 on the wire.
   */
  readonly after?: MailboxCursor;
  /**
   * Direction filter. Omit (or pass `in`) for the spec-conformant
   * recipient feed; `out` returns the sender-side feed; `both` returns
   * the combined feed with each header tagged.
   */
  readonly direction?: MailboxDirection;
}

/**
 * Typed client for `GET /mailbox` and `POST /mailbox/read`.
 *
 * Both `asc` (forward catch-up) and `desc` (backward browsing) apply a
 * strict tuple compare on the cursor so consecutive pages don't overlap.
 * See the protocol whitepaper section 10.1 for the full semantics and
 * the per-leg cursor contract.
 */
export class MailboxClient {
  readonly #baseUrl: string;
  readonly #token: string;

  constructor(baseUrl: string, token: string) {
    this.#baseUrl = baseUrl;
    this.#token = token;
  }

  list(opts: ListMailboxOptions = {}): Promise<GetMailboxResponse> {
    const params = new URLSearchParams();
    if (opts.order !== undefined) {
      params.set("order", opts.order);
    }
    if (opts.limit !== undefined) {
      params.set("limit", String(opts.limit));
    }
    if (opts.unread !== undefined) {
      params.set("unread", String(opts.unread));
    }
    if (opts.after !== undefined) {
      params.set("after_created_at", String(opts.after.created_at));
      params.set("after_envelope_id", opts.after.envelope_id);
    }
    if (opts.direction !== undefined) {
      params.set("direction", opts.direction);
    }
    const qs = params.toString();
    return asmtpRequest<GetMailboxResponse>({
      baseUrl: this.#baseUrl,
      path: `/mailbox${qs.length > 0 ? `?${qs}` : ""}`,
      method: "GET",
      token: this.#token,
    });
  }

  /**
   * Mark envelopes read without fetching their bodies. Returns the ids the
   * operator actually transitioned (ids the caller does not own are silently
   * dropped — the response carries the entitled subset).
   */
  markRead(ids: readonly EnvelopeId[]): Promise<PostReadResponse> {
    return asmtpRequest<PostReadResponse>({
      baseUrl: this.#baseUrl,
      path: "/mailbox/read",
      method: "POST",
      token: this.#token,
      body: { ids },
    });
  }
}
