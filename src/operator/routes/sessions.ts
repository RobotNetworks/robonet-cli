import { requireAgent } from "../auth.js";
import type { SessionService } from "../domain/sessions.js";
import { BadRequestError } from "../errors.js";
import { assertHandle } from "../handles.js";
import type { OperatorRepository } from "../storage/repository.js";
import type { Handle } from "../storage/types.js";
import { parseJsonBody, sendJson, sendNoContent } from "./json.js";
import type { Router } from "./router.js";

interface SessionRoutesContext {
  readonly repo: OperatorRepository;
  readonly service: SessionService;
}

/**
 * Register `/sessions/*` routes on `router`.
 *
 * Every route is bearer-auth'd via {@link requireAgent}: the bearer
 * resolves to an agent record, and the agent's handle is the implicit
 * caller for the operation. The route handlers translate JSON request
 * bodies into typed service inputs and serialize results back.
 */
export function registerSessionRoutes(router: Router, ctx: SessionRoutesContext): void {
  router.add("GET", "/sessions", (rc) => {
    const agent = requireAgent(rc.req, ctx.repo.agents);
    const sessions = ctx.service.listSessionsFor(agent.handle);
    sendJson(rc.res, 200, { sessions });
  });

  router.add("POST", "/sessions", async (rc) => {
    const agent = requireAgent(rc.req, ctx.repo.agents);
    const body = await parseJsonBody(rc.req);
    const invite = parseHandleArray(body.invite, "invite");
    const topic = parseOptionalString(body.topic, "topic");
    const initialMessage = parseInitialMessage(body.initial_message);
    const endAfterSend = parseOptionalBoolean(body.end_after_send, "end_after_send");
    const idempotencyKey = parseOptionalString(body.idempotency_key, "idempotency_key");

    const result = ctx.service.createSession({
      creator: agent.handle,
      invite,
      ...(topic !== undefined ? { topic } : {}),
      ...(initialMessage !== undefined ? { initialMessage } : {}),
      ...(endAfterSend !== undefined ? { endAfterSend } : {}),
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    });
    const out: Record<string, unknown> = { session_id: result.sessionId };
    if (result.sequence !== null) out.sequence = result.sequence;
    // 201 Created per RFC 9110 §15.3.2: a new session resource is identified
    // by `session_id`. Lifecycle verbs (join, invite, leave, end, reopen)
    // mutate state without creating a top-level resource and stay 200.
    sendJson(rc.res, 201, out);
  });

  router.add("GET", "/sessions/:id", (rc) => {
    const agent = requireAgent(rc.req, ctx.repo.agents);
    const view = ctx.service.getSessionView(agent.handle, rc.params.id);
    sendJson(rc.res, 200, view);
  });

  router.add("POST", "/sessions/:id/join", (rc) => {
    const agent = requireAgent(rc.req, ctx.repo.agents);
    ctx.service.joinSession(agent.handle, rc.params.id);
    sendJson(rc.res, 200, { ok: true });
  });

  router.add("POST", "/sessions/:id/invite", async (rc) => {
    const agent = requireAgent(rc.req, ctx.repo.agents);
    const body = await parseJsonBody(rc.req);
    const invite = parseHandleArray(body.invite, "invite");
    if (invite.length === 0) {
      throw new BadRequestError("invite must be a non-empty array", "INVALID_INVITE");
    }
    const invited = ctx.service.inviteToSession(agent.handle, rc.params.id, invite);
    sendJson(rc.res, 200, { invited });
  });

  router.add("POST", "/sessions/:id/messages", async (rc) => {
    const agent = requireAgent(rc.req, ctx.repo.agents);
    const body = await parseJsonBody(rc.req);
    const content = body.content;
    if (content === undefined || content === null) {
      throw new BadRequestError("content is required", "INVALID_CONTENT");
    }
    const idempotencyKey = parseOptionalString(body.idempotency_key, "idempotency_key");
    const metadata = parseOptionalObject(body.metadata, "metadata");
    const result = ctx.service.sendMessage({
      sender: agent.handle,
      sessionId: rc.params.id,
      content,
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
    });
    // 201 Created per RFC 9110 §15.3.2: a new message resource is identified
    // by `message_id`.
    sendJson(rc.res, 201, {
      message_id: result.messageId,
      sequence: result.sequence,
    });
  });

  router.add("POST", "/sessions/:id/leave", (rc) => {
    const agent = requireAgent(rc.req, ctx.repo.agents);
    ctx.service.leaveSession(agent.handle, rc.params.id);
    sendNoContent(rc.res);
  });

  router.add("POST", "/sessions/:id/end", (rc) => {
    const agent = requireAgent(rc.req, ctx.repo.agents);
    ctx.service.endSession(agent.handle, rc.params.id);
    sendNoContent(rc.res);
  });

  router.add("POST", "/sessions/:id/reopen", async (rc) => {
    const agent = requireAgent(rc.req, ctx.repo.agents);
    const body = await parseJsonBody(rc.req);
    const invite = parseHandleArray(body.invite, "invite");
    const initialMessage = parseInitialMessage(body.initial_message);
    ctx.service.reopenSession({
      handle: agent.handle,
      sessionId: rc.params.id,
      invite,
      ...(initialMessage !== undefined ? { initialMessage } : {}),
    });
    sendJson(rc.res, 200, { ok: true });
  });

  router.add("GET", "/sessions/:id/events", (rc) => {
    const agent = requireAgent(rc.req, ctx.repo.agents);
    const after = parseAfterSequence(rc.url);
    const limit = parseLimit(rc.url);
    const events = ctx.service.getEventsFor(agent.handle, rc.params.id, after, limit);
    sendJson(rc.res, 200, { events });
  });
}

/* -------------------------------------------------------------------------- */
/* Body parsing                                                                */
/* -------------------------------------------------------------------------- */

function parseHandleArray(raw: unknown, field: string): readonly Handle[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new BadRequestError(`${field} must be an array of handles`, "INVALID_INVITE");
  }
  return raw.map((h, i) => assertHandle(h, `${field}[${i}]`));
}

function parseOptionalString(raw: unknown, field: string): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    throw new BadRequestError(`${field} must be a string`, "INVALID_REQUEST");
  }
  return raw;
}

function parseOptionalBoolean(raw: unknown, field: string): boolean | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "boolean") {
    throw new BadRequestError(`${field} must be a boolean`, "INVALID_REQUEST");
  }
  return raw;
}

function parseOptionalObject(
  raw: unknown,
  field: string,
): Readonly<Record<string, unknown>> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new BadRequestError(`${field} must be an object`, "INVALID_REQUEST");
  }
  return raw as Readonly<Record<string, unknown>>;
}

function parseInitialMessage(raw: unknown): { readonly content: unknown; readonly metadata?: Readonly<Record<string, unknown>> } | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new BadRequestError(
      "initial_message must be an object",
      "INVALID_REQUEST",
    );
  }
  const o = raw as Record<string, unknown>;
  if (o.content === undefined) {
    throw new BadRequestError(
      "initial_message.content is required",
      "INVALID_REQUEST",
    );
  }
  const metadata = parseOptionalObject(o.metadata, "initial_message.metadata");
  return metadata === undefined
    ? { content: o.content }
    : { content: o.content, metadata };
}

function parseAfterSequence(url: URL): number {
  const v = url.searchParams.get("after_sequence");
  if (v === null || v.length === 0) return 0;
  const n = Number.parseInt(v, 10);
  if (!Number.isInteger(n) || n < 0 || String(n) !== v) {
    throw new BadRequestError(
      "after_sequence must be a non-negative integer",
      "INVALID_QUERY",
    );
  }
  return n;
}

function parseLimit(url: URL): number {
  const v = url.searchParams.get("limit");
  if (v === null || v.length === 0) return 1_000;
  const n = Number.parseInt(v, 10);
  if (!Number.isInteger(n) || n < 1 || n > 1_000 || String(n) !== v) {
    throw new BadRequestError(
      "limit must be an integer between 1 and 1000",
      "INVALID_QUERY",
    );
  }
  return n;
}
