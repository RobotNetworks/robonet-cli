/**
 * Wire types for the account-scoped surface (`robotnet account ...`).
 *
 * RobotNet-specific (not ASP). The hosted backend exposes these to a
 * human-driven principal — Cognito ID tokens or user-OAuth (`robotnet login`
 * PKCE) bearers. Agent-scoped tokens are explicitly rejected at the auth
 * boundary by `get_account_principal` (see backend
 * `src/functions/api/app/dependencies.py`); never wire an agent bearer
 * onto these calls.
 *
 * Pydantic mirrors:
 *   `AgentResponse`        ← already typed in `src/agents/types.ts`
 *   `AgentListResponse`    ← below
 *   `AgentCreate`          ← below
 *   `AgentUpdate`          ← below
 *   `AccountSessionsResponse` + `AccountSessionListItem`
 *   `GetSessionResponse`   ← already typed via `SessionWire` in `src/asp/types.ts`
 */
import type { Handle, Participant, SessionId, SessionState, Timestamp } from "../asp/types.js";
import type {
  AgentResponse,
  AgentSkill,
  AgentVisibility,
} from "../agents/types.js";
import type { InboundPolicy } from "../asp/types.js";

export interface AgentListResponse {
  readonly agents: readonly AgentResponse[];
  readonly next_cursor: string | null;
}

/** Body for `POST /agents` (create personal agent). Mirrors backend `AgentCreate`. */
export interface AgentCreate {
  readonly local_name: string;
  readonly display_name: string;
  readonly description?: string | null;
  readonly visibility?: AgentVisibility;
  readonly inbound_policy?: InboundPolicy;
  readonly can_initiate_sessions?: boolean;
}

/** Body for `PATCH /agents/{id}` and `PATCH /agents/{owner}/{name}`. Mirrors backend `AgentUpdate`. */
export interface AgentUpdate {
  readonly display_name?: string;
  readonly description?: string | null;
  readonly card_body?: string | null;
  readonly skills?: readonly AgentSkill[] | null;
  readonly visibility?: AgentVisibility;
  readonly inbound_policy?: InboundPolicy;
  readonly can_initiate_sessions?: boolean;
  readonly paused?: boolean;
}

/** One row in the account-aggregated session list. */
export interface AccountSessionListItem {
  readonly session: AccountSessionView;
  /** Which of the account's owned agents acts in this session. */
  readonly acting_handle: Handle;
}

/** Mirrors backend `AccountSessionsResponse` (operator extension). */
export interface AccountSessionsResponse {
  readonly sessions: readonly AccountSessionListItem[];
  readonly next_cursor: string | null;
}

/**
 * The `session` field of an `AccountSessionListItem`. Same shape as the
 * `GetSessionResponse` Pydantic model — duplicated here as a typed local
 * because `SessionWire` in `src/asp/types.ts` doesn't include `ended_at`
 * and we want to render that for closed sessions.
 */
export interface AccountSessionView {
  readonly id: SessionId;
  readonly state: SessionState;
  readonly topic: string | null;
  readonly participants: readonly Participant[];
  readonly created_at: Timestamp;
  readonly ended_at: Timestamp | null;
}
