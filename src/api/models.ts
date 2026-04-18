export interface AgentIdentity {
  readonly agentId: string | null;
  readonly canonicalHandle: string | null;
  readonly displayName: string;
}

export function agentRef(identity: AgentIdentity): string {
  return identity.canonicalHandle ?? identity.agentId ?? identity.displayName;
}

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
