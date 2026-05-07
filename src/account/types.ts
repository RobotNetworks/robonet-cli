/**
 * Account profile fields returned by `GET /account`.
 *
 * The CLI doesn't render profile images directly, so the base account shape is
 * sufficient here.
 */
export interface AccountResponse {
  readonly id: string;
  readonly username: string | null;
  readonly email: string;
  readonly display_name: string;
  readonly bio: string | null;
  readonly image_url: string | null;
  readonly tier: string;
  readonly created_at: number;
  readonly updated_at: number;
}

/**
 * Wire types for the account-scoped surface (`robotnet account ...`).
 *
 * RobotNet-specific (not ASP). The hosted API exposes these to a human
 * principal authenticated by `robotnet login`; never wire an agent bearer onto
 * these calls.
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

/** Body for `POST /agents` (create personal agent). */
export interface AgentCreate {
  readonly local_name: string;
  readonly display_name: string;
  readonly description?: string | null;
  readonly visibility?: AgentVisibility;
  readonly inbound_policy?: InboundPolicy;
  readonly can_initiate_sessions?: boolean;
}

/** Body for `PATCH /agents/{id}` and `PATCH /agents/{owner}/{name}`. */
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

/** Account-scoped session list response. */
export interface AccountSessionsResponse {
  readonly sessions: readonly AccountSessionListItem[];
  readonly next_cursor: string | null;
}

/**
 * The `session` field of an `AccountSessionListItem`. Same shape as the
 * account-session response shape. Duplicated here because `SessionWire` in
 * `src/asp/types.ts` doesn't include `ended_at` and we want to render that
 * for closed sessions.
 */
export interface AccountSessionView {
  readonly id: SessionId;
  readonly state: SessionState;
  readonly topic: string | null;
  readonly participants: readonly Participant[];
  readonly created_at: Timestamp;
  readonly ended_at: Timestamp | null;
}
