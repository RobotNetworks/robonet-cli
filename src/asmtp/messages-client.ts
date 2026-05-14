import { asmtpRequest } from "./http.js";
import type {
  Envelope,
  EnvelopeId,
  EnvelopePost,
  GetMessagesBatchResponse,
  PostMessagesResponse,
} from "./types.js";

/**
 * Typed client for `POST /messages`, `GET /messages/{id}`, and the batch
 * `GET /messages?ids=...` surface.
 *
 * The wire stamps `from` on the operator side, so {@link EnvelopePost}
 * intentionally omits it. The 202 response carries the operator-stamped
 * `created_at` plus one entry per successfully-stored recipient.
 *
 * Per the spec, fetching a body (single or batch) marks the envelope read
 * for the caller. Unentitled ids are silently omitted from batch responses.
 */
export class MessagesClient {
  readonly #baseUrl: string;
  readonly #token: string;

  constructor(baseUrl: string, token: string) {
    this.#baseUrl = baseUrl;
    this.#token = token;
  }

  /** Send an envelope. Returns the operator's 202 envelope (id, created_at, per-recipient ack). */
  send(envelope: EnvelopePost): Promise<PostMessagesResponse> {
    return asmtpRequest<PostMessagesResponse>({
      baseUrl: this.#baseUrl,
      path: "/messages",
      method: "POST",
      token: this.#token,
      body: envelope,
    });
  }

  /** Fetch one envelope body. Marks the envelope read for the caller. */
  fetchOne(id: EnvelopeId): Promise<Envelope> {
    return asmtpRequest<Envelope>({
      baseUrl: this.#baseUrl,
      path: `/messages/${encodeURIComponent(id)}`,
      method: "GET",
      token: this.#token,
    });
  }

  /**
   * Batch fetch envelope bodies. Marks each returned envelope read.
   * Unentitled ids are silently omitted. Duplicates in the request list are
   * server-side deduped; the response orders by first-occurrence in `ids`.
   */
  async fetchBatch(ids: readonly EnvelopeId[]): Promise<readonly Envelope[]> {
    if (ids.length === 0) return [];
    const query = ids.map((id) => encodeURIComponent(id)).join(",");
    const body = await asmtpRequest<GetMessagesBatchResponse>({
      baseUrl: this.#baseUrl,
      path: `/messages?ids=${query}`,
      method: "GET",
      token: this.#token,
    });
    return body.envelopes;
  }
}
