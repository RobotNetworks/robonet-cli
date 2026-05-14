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
 * Operator-extension shapes (not part of the open wire protocol). The hosted
 * API exposes these to a human principal authenticated by `robotnet login`;
 * never wire an agent bearer onto these calls.
 */
import type { InboundPolicy } from "../asmtp/types.js";
import type {
  AgentResponse,
  AgentSkill,
  AgentVisibility,
} from "../agents/types.js";

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
}

/** Body for `PATCH /agents/{id}` and `PATCH /agents/{owner}/{name}`. */
export interface AgentUpdate {
  readonly display_name?: string;
  readonly description?: string | null;
  readonly card_body?: string | null;
  readonly skills?: readonly AgentSkill[] | null;
  readonly visibility?: AgentVisibility;
  readonly inbound_policy?: InboundPolicy;
  readonly paused?: boolean;
}
