/**
 * Wire types for the RobotNet agent-discovery surface.
 *
 * RobotNet-specific (not part of ASP) — the hosted operator exposes these in
 * addition to the protocol's `/sessions/*` and `/_admin/*`. Shapes mirror the
 * backend Pydantic models in `domain/models/{agent,search}.py` so a single
 * server response renders identically across `robotnet-web` and the CLI.
 */
import type { Handle, InboundPolicy } from "../asp/types.js";

export type AgentVisibility = "public" | "private";
export type AgentScope = "personal" | "member" | "shared";
export type AgentOwnerType = "account" | "organization";
export type ViewerRelationship = "anonymous" | "none" | "owner";
export type SessionState = "active" | "ended";

export interface AgentSkill {
  readonly name: string;
  readonly description: string;
}

/**
 * Limited shape returned to anonymous viewers + non-contacts.
 *
 * Mirrors backend `AgentPublicResponse`. Card and skills are deliberately
 * absent — they are the gated surface.
 */
export interface AgentPublicResponse {
  readonly canonical_handle: Handle;
  readonly display_name: string;
  readonly description: string | null;
  readonly image_url: string | null;
  readonly visibility: AgentVisibility;
  readonly inbound_policy: InboundPolicy;
  readonly inactive: boolean;
  readonly is_online: boolean;
  readonly owner_label: string;
  readonly owner_display_name: string;
  readonly owner_image_url: string | null;
}

/**
 * Full shape returned to owners and contacts.
 *
 * Mirrors backend `AgentResponse`. Carries `card_body` and `skills` plus the
 * structural fields (id, scope, owner_type, can_initiate_sessions, paused,
 * created_at, updated_at) gated behind a relationship.
 */
export interface AgentResponse extends AgentPublicResponse {
  readonly id: string;
  readonly local_name: string;
  readonly namespace: string;
  readonly owner_type: AgentOwnerType;
  readonly owner_id: string;
  readonly scope: AgentScope;
  readonly can_initiate_sessions: boolean;
  readonly paused: boolean;
  readonly card_body: string | null;
  readonly skills: readonly AgentSkill[] | null;
  readonly created_at: number;
  readonly updated_at: number;
}

/** Either shape — narrow with {@link isFullAgentResponse}. */
export type AgentDetail = AgentPublicResponse | AgentResponse;

export function isFullAgentResponse(rec: AgentDetail): rec is AgentResponse {
  return "created_at" in rec;
}

export interface SharedSessionSummary {
  readonly id: string;
  readonly topic: string | null;
  readonly state: SessionState;
  readonly last_activity_at: number;
  readonly created_at: number;
}

export interface AgentViewerContext {
  readonly relationship: ViewerRelationship;
  readonly can_edit: boolean;
}

/**
 * Wrapper returned by `GET /agents/{owner}/{agent_name}`. The bare agent
 * record is at `.agent`; the wrapper also carries viewer context and any
 * sessions the viewer shares with the target.
 */
export interface AgentDetailResponse {
  readonly agent: AgentDetail;
  readonly shared_sessions: readonly SharedSessionSummary[];
  readonly viewer: AgentViewerContext;
}

export interface AgentSearchResult {
  readonly type: "agent";
  readonly id: string;
  readonly canonical_handle: Handle;
  readonly display_name: string;
  readonly image_url: string | null;
}

export interface PersonSearchResult {
  readonly type: "person";
  readonly id: string;
  readonly username: string;
  readonly display_name: string;
  readonly image_url: string | null;
}

export interface OrganizationSearchResult {
  readonly type: "organization";
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly image_url: string | null;
}

/** Mirrors backend `AgentDirectorySearchResponse`. */
export interface AgentDirectorySearchResponse {
  readonly agents: readonly AgentSearchResult[];
}

/** Mirrors backend `SearchResponse`. */
export interface DirectorySearchResponse {
  readonly agents: readonly AgentSearchResult[];
  readonly people: readonly PersonSearchResult[];
  readonly organizations: readonly OrganizationSearchResult[];
}

/** Body of `PATCH /agents/me`. Mirrors backend `AgentSelfUpdate`. */
export interface AgentSelfUpdate {
  readonly display_name?: string;
  readonly description?: string | null;
  readonly card_body?: string | null;
  readonly skills?: readonly AgentSkill[] | null;
}

/** One row in the block list returned by `GET /blocks`. */
export interface BlockedAgent {
  readonly blocked_agent_id: string;
  readonly blocked_handle: Handle;
  readonly created_at: number;
}

/** Response shape for `GET /blocks` (acting agent's own block list). */
export interface BlockListResponse {
  readonly blocks: readonly BlockedAgent[];
  readonly next_cursor: string | null;
}
