import type Database from "better-sqlite3";

import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../errors.js";
import { assertHandle } from "../handles.js";
import type { OperatorRepository } from "../storage/repository.js";
import type {
  EventRecord,
  Handle,
  MessageRecord,
  ParticipantRecord,
  SessionId,
  SessionRecord,
  Sequence,
} from "../storage/types.js";
import type { ConnectionRegistry } from "./transport.js";
import { isEligible } from "./eligibility.js";
import { containsFileId, type FileService, resolveContentFiles } from "./files.js";
import { mintId } from "./ids.js";
import { isReachable } from "./policy.js";

/* -------------------------------------------------------------------------- */
/* Public service API                                                          */
/* -------------------------------------------------------------------------- */

export interface InitialMessage {
  readonly content: unknown;
  readonly metadata?: Readonly<Record<string, unknown>> | null;
}

export interface CreateSessionInput {
  readonly creator: Handle;
  readonly invite: readonly Handle[];
  readonly topic?: string | null;
  readonly initialMessage?: InitialMessage | null;
  readonly endAfterSend?: boolean;
  readonly idempotencyKey?: string | null;
}

export interface CreateSessionResult {
  readonly sessionId: SessionId;
  /** Sequence of the initial message, if one was sent. */
  readonly sequence: Sequence | null;
}

export interface SendMessageInput {
  readonly sender: Handle;
  readonly sessionId: SessionId;
  readonly content: unknown;
  readonly idempotencyKey?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>> | null;
}

export interface SendMessageResult {
  readonly messageId: string;
  readonly sequence: Sequence;
}

export interface SessionView {
  readonly id: SessionId;
  readonly state: "active" | "ended";
  readonly topic?: string;
  readonly participants: readonly {
    readonly handle: Handle;
    readonly status: ParticipantRecord["status"];
    readonly joined_at?: number;
    readonly left_at?: number;
  }[];
  readonly created_at: number;
  readonly ended_at?: number;
}

/**
 * The operator's session/event service.
 *
 * Each public mutating method runs inside a single SQLite transaction so
 * the state change + event-log append commit atomically. Live fan-out is
 * deferred until after commit — we collect a list of `(handle, payload)`
 * pairs inside the transaction and dispatch them via {@link ConnectionRegistry}
 * once the writer lock has been released.
 *
 * Eligibility and trust enforcement live in `./policy.ts` and
 * `./eligibility.ts`; this module composes them with the storage layer.
 */
export class SessionService {
  readonly #repo: OperatorRepository;
  readonly #db: Database.Database;
  readonly #transport: ConnectionRegistry;
  readonly #files: FileService | null;

  constructor(
    repo: OperatorRepository,
    db: Database.Database,
    transport: ConnectionRegistry,
    files: FileService | null = null,
  ) {
    this.#repo = repo;
    this.#db = db;
    this.#transport = transport;
    // Optional only because read-paths (replay) construct the service
    // without files. Inbound writes that carry ``file_id`` parts fail
    // closed when ``files`` is missing — same posture as the trust hooks.
    this.#files = files;
  }

  /* -- create_session ----------------------------------------------------- */

  createSession(input: CreateSessionInput): CreateSessionResult {
    if (input.endAfterSend && input.initialMessage == null) {
      throw new BadRequestError(
        "end_after_send requires initial_message",
        "INVALID_REQUEST",
      );
    }
    const creator = assertHandle(input.creator, "creator");
    const invite = (input.invite ?? []).map((h) => assertHandle(h, "invite[]"));

    let result: { sessionId: SessionId; sequence: Sequence | null; dispatches: readonly Dispatch[] };
    try {
      result = this.#db.transaction(() => {
        // Reachability check — privacy-preserving: any unreachable invitee
        // fails the whole request as 404 (Whitepaper §6.2).
        for (const target of invite) {
          if (!isReachable(this.#repo, creator, target)) {
            throw new NotFoundError("not found");
          }
        }

        const sessionId = mintId("sess");
        const session = this.#repo.sessions.create({
          id: sessionId,
          creatorHandle: creator,
          ...(input.topic !== undefined ? { topic: input.topic } : {}),
        });
        this.#repo.participants.add(sessionId, creator, "joined");

        // Add invitees first so their session.invited events have valid
        // recipient rows on the participants table.
        for (const target of invite) {
          this.#repo.participants.add(sessionId, target, "invited");
        }

        // Emit session.invited per invitee. If end_after_send + initial_message,
        // we need the message body inline on each invited event — so build
        // the message envelope first, then pass it into the invited payload.
        let initialMessage: MessageRecord | null = null;
        let initialSeq: Sequence | null = null;
        if (input.initialMessage != null) {
          const { content: durable, fileIds } = this.#resolveFiles(
            input.initialMessage.content,
            creator,
          );
          initialMessage = this.#insertMessage({
            sender: creator,
            sessionId,
            content: durable,
            metadata: input.initialMessage.metadata ?? null,
            idempotencyKey: null,
          });
          if (fileIds.length > 0 && this.#files !== null) {
            this.#files.claimForMessage(fileIds, initialMessage.id, creator);
          }
          initialSeq = initialMessage.sequence;
        }

        for (const target of invite) {
          const payload: Record<string, unknown> = {
            invitee: target,
            by: creator,
          };
          if (input.topic !== undefined && input.topic !== null) {
            payload.topic = input.topic;
          }
          if (input.endAfterSend && initialMessage !== null) {
            payload.initial_message = wireMessage(initialMessage);
          }
          this.#appendEvent(sessionId, "session.invited", payload);
        }

        if (initialMessage !== null) {
          // session.message goes to the creator (and any other joined party,
          // but on a new session that's just the creator). Eligibility filter
          // takes care of "invited can't see it".
          this.#appendEvent(sessionId, "session.message", wireMessage(initialMessage));
        }

        if (input.endAfterSend) {
          this.#repo.sessions.setState(sessionId, "ended");
          this.#appendEvent(sessionId, "session.ended", { ended_by: creator });
        }
        void session;

        const dispatches = this.#collectDispatches(sessionId);
        return { sessionId, sequence: initialSeq, dispatches };
      })();
    } catch (err) {
      throw err;
    }

    this.#dispatch(result.dispatches);
    return { sessionId: result.sessionId, sequence: result.sequence };
  }

  /* -- join_session ------------------------------------------------------- */

  joinSession(handle: Handle, sessionId: SessionId): void {
    const dispatches = this.#db.transaction(() => {
      const session = this.#requireActive(sessionId);
      void session;
      const participant = this.#repo.participants.get(sessionId, handle);
      if (participant === null) {
        // Not invited — masked as 404 per §6.2.
        throw new NotFoundError("not found");
      }
      if (participant.status === "joined") return [] as readonly Dispatch[];
      if (participant.status === "left") {
        throw new ConflictError("cannot rejoin without re-invitation", "ALREADY_LEFT");
      }
      this.#repo.participants.setStatus(sessionId, handle, "joined");
      this.#appendEvent(sessionId, "session.joined", { agent: handle });
      return this.#collectDispatches(sessionId);
    })();
    this.#dispatch(dispatches);
  }

  /* -- invite_to_session -------------------------------------------------- */

  inviteToSession(
    caller: Handle,
    sessionId: SessionId,
    invite: readonly Handle[],
  ): readonly Handle[] {
    const result = this.#db.transaction(() => {
      this.#requireActive(sessionId);
      this.#requireJoined(sessionId, caller);

      const invited: Handle[] = [];
      for (const target of invite) {
        if (!isReachable(this.#repo, caller, target)) continue; // §6.2 silent omission
        const existing = this.#repo.participants.get(sessionId, target);
        if (existing !== null && (existing.status === "invited" || existing.status === "joined")) {
          continue;
        }
        if (existing !== null && existing.status === "left") {
          this.#repo.participants.setStatus(sessionId, target, "invited");
        } else {
          this.#repo.participants.add(sessionId, target, "invited");
        }
        this.#appendEvent(sessionId, "session.invited", {
          invitee: target,
          by: caller,
        });
        invited.push(target);
      }
      const dispatches = this.#collectDispatches(sessionId);
      return { invited, dispatches };
    })();
    this.#dispatch(result.dispatches);
    return result.invited;
  }

  /* -- send_message ------------------------------------------------------- */

  sendMessage(input: SendMessageInput): SendMessageResult {
    const result = this.#db.transaction(() => {
      this.#requireActive(input.sessionId);
      this.#requireJoined(input.sessionId, input.sender);

      if (input.idempotencyKey != null) {
        const cached = this.#repo.idempotency.lookup(
          input.sessionId,
          input.sender,
          input.idempotencyKey,
        );
        if (cached !== null) {
          // Idempotency replay short-circuits BEFORE file_id resolution
          // so a retry does not re-claim files (already claimed on the
          // first call).
          return {
            messageId: cached.messageId,
            sequence: cached.sequence,
            dispatches: [] as readonly Dispatch[],
          };
        }
      }

      const { content: durableContent, fileIds } = this.#resolveFiles(
        input.content,
        input.sender,
      );

      const message = this.#insertMessage({
        sender: input.sender,
        sessionId: input.sessionId,
        content: durableContent,
        idempotencyKey: input.idempotencyKey ?? null,
        metadata: input.metadata ?? null,
      });
      if (fileIds.length > 0 && this.#files !== null) {
        this.#files.claimForMessage(fileIds, message.id, input.sender);
      }
      this.#appendEvent(input.sessionId, "session.message", wireMessage(message));

      if (input.idempotencyKey != null) {
        this.#repo.idempotency.record({
          sessionId: input.sessionId,
          senderHandle: input.sender,
          key: input.idempotencyKey,
          messageId: message.id,
          sequence: message.sequence,
        });
      }

      const dispatches = this.#collectDispatches(input.sessionId);
      return {
        messageId: message.id,
        sequence: message.sequence,
        dispatches,
      };
    })();
    this.#dispatch(result.dispatches);
    return { messageId: result.messageId, sequence: result.sequence };
  }

  #resolveFiles(
    content: unknown,
    senderHandle: Handle,
  ): { content: unknown; fileIds: readonly string[] } {
    if (this.#files === null) {
      if (containsFileId(content)) {
        throw new Error(
          "SessionService instantiated without files dep, but request carries file_id",
        );
      }
      return { content, fileIds: [] };
    }
    return resolveContentFiles(content, this.#files, senderHandle);
  }

  /* -- leave_session ------------------------------------------------------ */

  leaveSession(handle: Handle, sessionId: SessionId): void {
    const dispatches = this.#db.transaction(() => {
      this.#requireActive(sessionId);
      this.#requireJoined(sessionId, handle);
      this.#repo.participants.setStatus(sessionId, handle, "left");
      this.#appendEvent(sessionId, "session.left", {
        agent: handle,
        reason: "left",
      });
      return this.#collectDispatches(sessionId);
    })();
    this.#dispatch(dispatches);
  }

  /* -- end_session -------------------------------------------------------- */

  endSession(handle: Handle, sessionId: SessionId): void {
    const dispatches = this.#db.transaction(() => {
      this.#requireActive(sessionId);
      this.#requireJoined(sessionId, handle);
      this.#repo.sessions.setState(sessionId, "ended");
      this.#appendEvent(sessionId, "session.ended", { ended_by: handle });
      return this.#collectDispatches(sessionId);
    })();
    this.#dispatch(dispatches);
  }

  /* -- reopen_session ----------------------------------------------------- */

  /**
   * Reopen an ended session. Per the Whitepaper §6.3, any agent that was a
   * `joined` participant when the session entered `ended` may reopen.
   * Optional `invite` and `initialMessage` mirror `createSession`.
   */
  reopenSession(args: {
    readonly handle: Handle;
    readonly sessionId: SessionId;
    readonly invite?: readonly Handle[];
    readonly initialMessage?: InitialMessage | null;
  }): void {
    const handle = assertHandle(args.handle, "handle");
    const invite = (args.invite ?? []).map((h) => assertHandle(h, "invite[]"));

    const dispatches = this.#db.transaction(() => {
      const session = this.#repo.sessions.byId(args.sessionId);
      if (session === null) throw new NotFoundError("not found");
      if (session.state !== "ended") {
        throw new ConflictError("session is not ended", "SESSION_NOT_ENDED");
      }
      const participant = this.#repo.participants.get(args.sessionId, handle);
      if (participant === null || participant.status !== "joined") {
        // Spec: only joined-when-ended participants may reopen. 403 when
        // present-but-not-joined; 404 for non-participants is privacy-preserving.
        if (participant === null) throw new NotFoundError("not found");
        throw new ForbiddenError("only joined-when-ended participants may reopen");
      }

      this.#repo.sessions.setState(args.sessionId, "active");
      this.#appendEvent(args.sessionId, "session.reopened", { reopened_by: handle });

      // Process the (optional) re-invite list — same trust + status rules
      // as createSession's invite path. Silent omission of unreachable
      // invitees per §6.2.
      for (const target of invite) {
        if (!isReachable(this.#repo, handle, target)) continue;
        const existing = this.#repo.participants.get(args.sessionId, target);
        if (existing === null) {
          this.#repo.participants.add(args.sessionId, target, "invited");
        } else {
          this.#repo.participants.setStatus(args.sessionId, target, "invited");
        }
        this.#appendEvent(args.sessionId, "session.invited", {
          invitee: target,
          by: handle,
        });
      }

      if (args.initialMessage != null) {
        const { content: durable, fileIds } = this.#resolveFiles(
          args.initialMessage.content,
          handle,
        );
        const message = this.#insertMessage({
          sender: handle,
          sessionId: args.sessionId,
          content: durable,
          metadata: args.initialMessage.metadata ?? null,
          idempotencyKey: null,
        });
        if (fileIds.length > 0 && this.#files !== null) {
          this.#files.claimForMessage(fileIds, message.id, handle);
        }
        this.#appendEvent(args.sessionId, "session.message", wireMessage(message));
      }

      return this.#collectDispatches(args.sessionId);
    })();
    this.#dispatch(dispatches);
  }

  /* -- read APIs ---------------------------------------------------------- */

  /** Session-view payload as the route layer hands to GET /sessions/:id. Throws 404 when caller is not a participant. */
  getSessionView(caller: Handle, sessionId: SessionId): SessionView {
    const session = this.#repo.sessions.byId(sessionId);
    if (session === null) throw new NotFoundError("not found");
    if (this.#repo.participants.get(sessionId, caller) === null) {
      // Mask non-participation as 404 per §6.2.
      throw new NotFoundError("not found");
    }
    return sessionToWire(session, this.#repo.participants.listForSession(sessionId));
  }

  /**
   * All sessions in which `caller` participates, most-recently-updated first.
   * Each entry carries the same wire shape as {@link getSessionView}. Hidden
   * by design: zero-result is not "not found" — an agent with no sessions
   * legitimately gets `[]`.
   */
  listSessionsFor(caller: Handle): readonly SessionView[] {
    const sessions = this.#repo.sessions.listForHandle(caller);
    return sessions.map((s) =>
      sessionToWire(s, this.#repo.participants.listForSession(s.id)),
    );
  }

  /**
   * Substring message search across sessions the caller could have seen.
   * Eligibility delegated to {@link MessagesRepo.searchForCaller}. Returns
   * messages in their wire shape, most-recent first.
   */
  searchMessages(args: {
    readonly caller: Handle;
    readonly query: string;
    readonly limit: number;
    readonly sessionId?: SessionId;
    readonly counterpartHandle?: Handle;
  }): readonly Readonly<Record<string, unknown>>[] {
    const records = this.#repo.messages.searchForCaller({
      callerHandle: args.caller,
      query: args.query,
      limit: args.limit,
      ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
      ...(args.counterpartHandle !== undefined
        ? { counterpartHandle: args.counterpartHandle }
        : {}),
    });
    return records.map(wireMessage);
  }

  /** Catch-up history for a session — eligibility-filtered per the participant's status transitions. */
  getEventsFor(
    caller: Handle,
    sessionId: SessionId,
    afterSequence: Sequence,
    limit: number,
  ): readonly Readonly<Record<string, unknown>>[] {
    const session = this.#repo.sessions.byId(sessionId);
    if (session === null) throw new NotFoundError("not found");
    if (this.#repo.participants.get(sessionId, caller) === null) {
      throw new NotFoundError("not found");
    }
    const events = this.#repo.events.listForSessionAfter(
      sessionId,
      afterSequence,
      limit + 1,
    );
    const eligible = filterHistoryEligible(caller, session.creatorHandle, events);
    return eligible.slice(0, limit).map(eventToWire);
  }

  /* -- presence transitions (called by ConnectionRegistry) ---------------- */

  /**
   * Fire `session.disconnected` to peers in every session this handle is
   * `joined` in. Invoked the moment the last WS for the handle closes.
   * Whitepaper §6.4: peers learn of the drop immediately; the agent's
   * own status is unchanged until grace expires.
   */
  onAgentWentOffline(handle: Handle): void {
    const dispatches = this.#db.transaction(() => {
      const all: Dispatch[] = [];
      for (const p of this.#repo.participants.listForHandle(handle)) {
        if (p.status !== "joined") continue;
        const session = this.#repo.sessions.byId(p.sessionId);
        if (session === null || session.state !== "active") continue;
        this.#appendEvent(p.sessionId, "session.disconnected", { agent: handle });
        for (const d of this.#collectDispatches(p.sessionId)) {
          all.push(d);
        }
      }
      return all;
    })();
    this.#dispatch(dispatches);
  }

  /**
   * Fire `session.reconnected` to peers in every session this handle is
   * still `joined` in (i.e. didn't grace-expire) and replay any events
   * the agent missed while offline.
   */
  onAgentCameBack(handle: Handle): void {
    const dispatches = this.#db.transaction(() => {
      const all: Dispatch[] = [];
      for (const p of this.#repo.participants.listForHandle(handle)) {
        if (p.status !== "joined") continue;
        const session = this.#repo.sessions.byId(p.sessionId);
        if (session === null || session.state !== "active") continue;
        this.#appendEvent(p.sessionId, "session.reconnected", { agent: handle });
        for (const d of this.#collectDispatches(p.sessionId)) {
          all.push(d);
        }
      }
      return all;
    })();
    this.#dispatch(dispatches);
    // Catch-up replay handles anything else the agent missed during the
    // window. Dispatches advance the agent's per-session cursor.
    this.replayForHandle(handle);
  }

  /**
   * Promote every `joined` participation for `handle` to `left` and emit
   * `session.left{reason: "grace_expired"}`. Invoked when the grace
   * window closes with the handle still offline.
   */
  onAgentGraceExpired(handle: Handle): void {
    const dispatches = this.#db.transaction(() => {
      const all: Dispatch[] = [];
      for (const p of this.#repo.participants.listForHandle(handle)) {
        if (p.status !== "joined") continue;
        const session = this.#repo.sessions.byId(p.sessionId);
        if (session === null || session.state !== "active") continue;
        this.#repo.participants.setStatus(p.sessionId, handle, "left");
        this.#appendEvent(p.sessionId, "session.left", {
          agent: handle,
          reason: "grace_expired",
        });
        for (const d of this.#collectDispatches(p.sessionId)) {
          all.push(d);
        }
      }
      return all;
    })();
    this.#dispatch(dispatches);
  }

  /**
   * Replay every event past each session's cursor for `handle`, applying
   * the live-eligibility filter. Called when a fresh `/connect` lands.
   *
   * Cursors advance only on successful dispatch — that way an offline
   * agent who briefly comes online but disconnects mid-replay can still
   * recover on a subsequent connect.
   */
  replayForHandle(handle: Handle): void {
    const dispatches: Dispatch[] = [];
    const participations = this.#repo.participants.listForHandle(handle);
    for (const p of participations) {
      if (p.status === "left") continue;
      const cursor = this.#repo.cursors.get(handle, p.sessionId);
      const events = this.#repo.events.listForSessionAfter(
        p.sessionId,
        cursor,
        1_000,
      );
      for (const ev of events) {
        if (!isEligible(p.status, ev.type)) continue;
        dispatches.push({ handle, event: ev });
      }
    }
    this.#dispatch(dispatches);
  }

  /* -- internals ---------------------------------------------------------- */

  #requireActive(sessionId: SessionId): SessionRecord {
    const session = this.#repo.sessions.byId(sessionId);
    if (session === null) throw new NotFoundError("not found");
    if (session.state !== "active") {
      throw new ConflictError("session is ended", "SESSION_ENDED");
    }
    return session;
  }

  #requireJoined(sessionId: SessionId, handle: Handle): ParticipantRecord {
    const p = this.#repo.participants.get(sessionId, handle);
    if (p === null || p.status !== "joined") {
      // 403 when present-but-wrong-status; 404 for non-participants is
      // privacy-preserving.
      if (p === null) throw new NotFoundError("not found");
      throw new ForbiddenError("agent is not joined to this session");
    }
    return p;
  }

  #insertMessage(args: {
    readonly sender: Handle;
    readonly sessionId: SessionId;
    readonly content: unknown;
    readonly idempotencyKey: string | null;
    readonly metadata: Readonly<Record<string, unknown>> | null;
  }): MessageRecord {
    const sequence = this.#repo.sessions.allocateSequence(args.sessionId);
    return this.#repo.messages.insert({
      id: mintId("msg"),
      sessionId: args.sessionId,
      senderHandle: args.sender,
      sequence,
      content: args.content,
      idempotencyKey: args.idempotencyKey,
      metadata: args.metadata,
    });
  }

  #appendEvent(
    sessionId: SessionId,
    type: string,
    payload: Readonly<Record<string, unknown>>,
  ): EventRecord {
    const sequence = this.#repo.sessions.allocateSequence(sessionId);
    return this.#repo.events.append({
      id: mintId("evt"),
      sessionId,
      sequence,
      type,
      payload,
    });
  }

  /**
   * Walk the session's participants, gather (handle, event) pairs whose
   * events are past each handle's cursor and pass the eligibility filter.
   *
   * Cursors are advanced in {@link #dispatch} only when a recipient is
   * actually online — offline recipients keep their cursor in place so
   * `replayForHandle` on next connect picks up the backlog.
   */
  #collectDispatches(sessionId: SessionId): readonly Dispatch[] {
    const dispatches: Dispatch[] = [];
    const participants = this.#repo.participants.listForSession(sessionId);
    for (const p of participants) {
      if (p.status === "left") continue;
      const cursor = this.#repo.cursors.get(p.handle, sessionId);
      const events = this.#repo.events.listForSessionAfter(sessionId, cursor, 1_000);
      for (const ev of events) {
        if (!isEligible(p.status, ev.type)) continue;
        dispatches.push({ handle: p.handle, event: ev });
      }
    }
    return dispatches;
  }

  #dispatch(dispatches: readonly Dispatch[]): void {
    for (const d of dispatches) {
      const payload = JSON.stringify(eventToWire(d.event));
      const sent = this.#transport.send(d.handle, payload);
      if (sent > 0) {
        // Recipient was online; advance the per-(handle, session) cursor
        // so a future replay-since on reconnect doesn't re-deliver.
        this.#repo.cursors.advance(d.handle, d.event.sessionId, d.event.sequence);
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

interface Dispatch {
  readonly handle: Handle;
  readonly event: EventRecord;
}

function wireMessage(m: MessageRecord): Readonly<Record<string, unknown>> {
  const wire: Record<string, unknown> = {
    id: m.id,
    session_id: m.sessionId,
    sender: m.senderHandle,
    sequence: m.sequence,
    content: m.content,
    created_at: m.createdAtMs,
  };
  if (m.idempotencyKey !== null) wire.idempotency_key = m.idempotencyKey;
  if (m.metadata !== null) wire.metadata = m.metadata;
  return wire;
}

function eventToWire(e: EventRecord): Readonly<Record<string, unknown>> {
  return {
    type: e.type,
    session_id: e.sessionId,
    event_id: e.id,
    sequence: e.sequence,
    created_at: e.createdAtMs,
    payload: e.payload,
  };
}

function sessionToWire(
  session: SessionRecord,
  participants: readonly ParticipantRecord[],
): SessionView {
  const view: {
    id: SessionId;
    state: "active" | "ended";
    topic?: string;
    participants: SessionView["participants"];
    created_at: number;
    ended_at?: number;
  } = {
    id: session.id,
    state: session.state,
    participants: participants.map((p) => {
      const out: {
        handle: Handle;
        status: ParticipantRecord["status"];
        joined_at?: number;
        left_at?: number;
      } = { handle: p.handle, status: p.status };
      if (p.joinedAtMs !== null) out.joined_at = p.joinedAtMs;
      if (p.leftAtMs !== null) out.left_at = p.leftAtMs;
      return out;
    }),
    created_at: session.createdAtMs,
  };
  if (session.topic !== null) view.topic = session.topic;
  if (session.endedAtMs !== null) view.ended_at = session.endedAtMs;
  return view;
}

/**
 * Replay-style history filter (Whitepaper §6.4 / Appendix C.5).
 *
 * Walks the full session log status-by-status for `caller`, yielding each
 * event the caller was eligible to see at the moment it fired. Mirrors
 * the Python reference operator's `_filter_eligible_history`.
 */
function filterHistoryEligible(
  caller: Handle,
  creator: Handle,
  events: readonly EventRecord[],
): readonly EventRecord[] {
  // Creators are joined from t=0 with no preceding session.joined event.
  let status: ParticipantRecord["status"] | "absent" =
    creator === caller ? "joined" : "absent";

  const out: EventRecord[] = [];
  for (const ev of events) {
    const payload = ev.payload;
    const payloadAgent =
      typeof payload["agent"] === "string" ? payload["agent"] : null;
    const payloadInvitee =
      typeof payload["invitee"] === "string" ? payload["invitee"] : null;

    // Events that change the caller's own status are always visible to
    // them: their own `session.invited`, `session.joined`, and
    // `session.left` are the markers in the transcript that capture
    // each transition. Computing eligibility from the *pre-event*
    // status would drop the caller's own ``session.joined`` (status
    // is still ``invited`` at that moment, and the ``invited`` branch
    // only admits ``session.invited`` + ``session.ended``).
    const isOwnTransition =
      (ev.type === "session.invited" && payloadInvitee === caller) ||
      (ev.type === "session.joined" && payloadAgent === caller) ||
      (ev.type === "session.left" && payloadAgent === caller);

    let eligible = isOwnTransition;
    if (!eligible) {
      if (status === "joined") {
        eligible = true;
      } else if (status === "invited") {
        eligible = ev.type === "session.invited" || ev.type === "session.ended";
      }
      // status === "absent" / "left": only their own transitions, handled above.
    }

    if (eligible) out.push(ev);

    // Update the running status based on this event.
    if (ev.type === "session.invited" && payloadInvitee === caller) {
      if (status === "absent" || status === "left") status = "invited";
    } else if (ev.type === "session.joined" && payloadAgent === caller) {
      status = "joined";
    } else if (ev.type === "session.left" && payloadAgent === caller) {
      status = "left";
    }
  }
  return out;
}
