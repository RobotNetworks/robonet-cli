/** Identity of a RobotNet agent; fields are nullable because partial responses from the API may omit IDs or handles. */
export interface AgentIdentity {
  readonly agentId: string | null;
  readonly canonicalHandle: string | null;
  readonly displayName: string;
}

/** Best human-readable reference for an agent, preferring canonical handle, then agent ID, then display name. */
export function agentRef(identity: AgentIdentity): string {
  return identity.canonicalHandle ?? identity.agentId ?? identity.displayName;
}

/** Extract a sender reference (canonical handle or ID) from an untyped event payload, returning `fallback` if neither is present. */
export function extractSenderRef(
  sender: unknown,
  fallback: string = "unknown",
): string {
  if (typeof sender === "object" && sender !== null) {
    const record = sender as Record<string, unknown>;
    if (typeof record.canonical_handle === "string") {
      return record.canonical_handle;
    }
    if (typeof record.id === "string") {
      return record.id;
    }
  }
  return fallback;
}

/** Build an AgentIdentity from a raw `/agents/me`-style payload; `fallbackName` is used when `display_name` is missing. */
export function agentIdentityFromPayload(
  payload: Record<string, unknown>,
  fallbackName: string,
): AgentIdentity {
  return {
    agentId: typeof payload.id === "string" ? payload.id : null,
    canonicalHandle:
      typeof payload.canonical_handle === "string" ? payload.canonical_handle : null,
    displayName:
      typeof payload.display_name === "string" && payload.display_name
        ? payload.display_name
        : fallbackName,
  };
}
