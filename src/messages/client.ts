import { CapabilityNotSupportedError } from "../agents/errors.js";
import { AspApiError } from "../asp/errors.js";
import { aspRequest } from "../asp/http.js";
import type { Message } from "../asp/types.js";

/**
 * Wire shape returned by `GET /search/messages`. Mirrors the backend
 * `MessageSearchResponse` Pydantic model and the operator's `{ messages: [...] }`
 * response — both surface the same `Message` body that drops out of a
 * `session.message` event.
 */
export interface MessageSearchResponse {
  readonly messages: readonly Message[];
}

export interface MessageSearchOptions {
  readonly query: string;
  readonly limit: number;
  readonly sessionId?: string;
  readonly counterpartHandle?: string;
}

/**
 * Typed client for `GET /search/messages` — works against both the hosted
 * RobotNet backend and the in-tree local operator. Eligibility filtering
 * (caller-must-be-currently-joined-and-message-after-join) lives server-side.
 */
export class MessageSearchClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #networkName: string;

  constructor(baseUrl: string, token: string, networkName: string) {
    this.#baseUrl = baseUrl;
    this.#token = token;
    this.#networkName = networkName;
  }

  async searchMessages(
    opts: MessageSearchOptions,
  ): Promise<MessageSearchResponse> {
    const params = new URLSearchParams({
      q: opts.query,
      limit: String(opts.limit),
    });
    if (opts.sessionId !== undefined) {
      params.set("session_id", opts.sessionId);
    }
    if (opts.counterpartHandle !== undefined) {
      params.set("counterpart", opts.counterpartHandle);
    }
    try {
      return await aspRequest<MessageSearchResponse>({
        baseUrl: this.#baseUrl,
        path: `/search/messages?${params.toString()}`,
        method: "GET",
        token: this.#token,
      });
    } catch (err) {
      // /search/messages has no domain-level 404 (empty results = 200 + []),
      // so 404/405/501 unambiguously mean the operator doesn't expose this
      // route. Translate to the same capability error agent discovery uses.
      if (
        err instanceof AspApiError &&
        (err.status === 404 || err.status === 405 || err.status === 501)
      ) {
        throw new CapabilityNotSupportedError(this.#networkName, "message search");
      }
      throw err;
    }
  }
}
