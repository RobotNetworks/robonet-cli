import { aspRequest } from "./http.js";
import type {
  ContentRequest,
  Handle,
  IdempotencyKey,
  MessageId,
  Metadata,
  SessionId,
  SessionWire,
  UnknownSessionEvent,
} from "./types.js";

export interface CreateSessionOptions {
  readonly invite?: readonly Handle[];
  readonly topic?: string;
  readonly initialMessage?: {
    readonly content: ContentRequest;
    readonly metadata?: Metadata;
  };
  readonly endAfterSend?: boolean;
  readonly idempotencyKey?: IdempotencyKey;
}

export interface SendMessageOptions {
  readonly idempotencyKey?: IdempotencyKey;
  readonly metadata?: Metadata;
}

export interface ReopenSessionOptions {
  readonly invite?: readonly Handle[];
  readonly initialMessage?: {
    readonly content: ContentRequest;
    readonly metadata?: Metadata;
  };
}

export interface CreateSessionResponse {
  readonly session_id: SessionId;
  readonly sequence?: number;
}

export interface SendMessageResponse {
  readonly message_id: MessageId;
  readonly sequence: number;
}

export interface InviteToSessionResponse {
  readonly invited: readonly Handle[];
}

export interface GetEventsResponse {
  readonly events: readonly UnknownSessionEvent[];
  readonly next_cursor?: string;
}

/**
 * Typed client for an agent's view of the protocol surface (`/sessions/*`).
 *
 * Authenticated by the calling agent's bearer token. Operations match the
 * Whitepaper Appendix C.1 REST surface; nothing here is admin-scoped.
 *
 * REST and WebSocket endpoints are passed in separately. Hosted ASP networks
 * (e.g. Robot Networks' public operator) front the WebSocket on a dedicated
 * gateway whose origin differs from the REST API's; computing the WS URL
 * by string-substituting the REST URL's scheme is wrong for those networks.
 * Callers (see `resolveSessionClient`) decide the right pair.
 */
export class AspSessionClient {
  readonly #baseUrl: string;
  readonly #wsUrl: string;
  readonly #token: string;

  constructor(baseUrl: string, wsUrl: string, token: string) {
    this.#baseUrl = baseUrl;
    this.#wsUrl = wsUrl;
    this.#token = token;
  }

  /** WebSocket URL for the event-stream handshake. */
  get wsUrl(): string {
    return this.#wsUrl;
  }

  /** The calling agent's bearer token (needed to authenticate the WS handshake). */
  get token(): string {
    return this.#token;
  }

  createSession(opts: CreateSessionOptions = {}): Promise<CreateSessionResponse> {
    return this.#post<CreateSessionResponse>("/sessions", {
      ...(opts.invite !== undefined ? { invite: opts.invite } : {}),
      ...(opts.topic !== undefined ? { topic: opts.topic } : {}),
      ...(opts.initialMessage !== undefined
        ? { initial_message: opts.initialMessage }
        : {}),
      ...(opts.endAfterSend === true ? { end_after_send: true } : {}),
      ...(opts.idempotencyKey !== undefined
        ? { idempotency_key: opts.idempotencyKey }
        : {}),
    });
  }

  listSessions(): Promise<readonly SessionWire[]> {
    return this.#get<{ sessions: readonly SessionWire[] }>("/sessions").then(
      (b) => b.sessions,
    );
  }

  showSession(sessionId: SessionId): Promise<SessionWire> {
    return this.#get<SessionWire>(`/sessions/${encodeURIComponent(sessionId)}`);
  }

  joinSession(sessionId: SessionId): Promise<void> {
    return this.#post<void>(`/sessions/${encodeURIComponent(sessionId)}/join`, {});
  }

  inviteToSession(
    sessionId: SessionId,
    handles: readonly Handle[],
  ): Promise<InviteToSessionResponse> {
    return this.#post<InviteToSessionResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/invite`,
      { invite: handles },
    );
  }

  sendMessage(
    sessionId: SessionId,
    content: ContentRequest,
    opts: SendMessageOptions = {},
  ): Promise<SendMessageResponse> {
    return this.#post<SendMessageResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/messages`,
      {
        content,
        ...(opts.idempotencyKey !== undefined
          ? { idempotency_key: opts.idempotencyKey }
          : {}),
        ...(opts.metadata !== undefined ? { metadata: opts.metadata } : {}),
      },
    );
  }

  leaveSession(sessionId: SessionId): Promise<void> {
    return this.#post<void>(`/sessions/${encodeURIComponent(sessionId)}/leave`, {});
  }

  endSession(sessionId: SessionId): Promise<void> {
    return this.#post<void>(`/sessions/${encodeURIComponent(sessionId)}/end`, {});
  }

  reopenSession(
    sessionId: SessionId,
    opts: ReopenSessionOptions = {},
  ): Promise<void> {
    return this.#post<void>(`/sessions/${encodeURIComponent(sessionId)}/reopen`, {
      ...(opts.invite !== undefined ? { invite: opts.invite } : {}),
      ...(opts.initialMessage !== undefined
        ? { initial_message: opts.initialMessage }
        : {}),
    });
  }

  getEvents(
    sessionId: SessionId,
    opts: { readonly afterSequence?: number; readonly limit?: number } = {},
  ): Promise<GetEventsResponse> {
    const params = new URLSearchParams();
    if (opts.afterSequence !== undefined) {
      params.set("after_sequence", String(opts.afterSequence));
    }
    if (opts.limit !== undefined) {
      params.set("limit", String(opts.limit));
    }
    const qs = params.toString();
    const path = `/sessions/${encodeURIComponent(sessionId)}/events${qs ? `?${qs}` : ""}`;
    return this.#get<GetEventsResponse>(path);
  }

  #get<T>(path: string): Promise<T> {
    return aspRequest<T>({
      baseUrl: this.#baseUrl,
      path,
      method: "GET",
      token: this.#token,
    });
  }

  #post<T>(path: string, body: unknown): Promise<T> {
    return aspRequest<T>({
      baseUrl: this.#baseUrl,
      path,
      method: "POST",
      token: this.#token,
      body,
    });
  }
}
