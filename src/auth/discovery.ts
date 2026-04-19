import { DISCOVERY_TIMEOUT_MS, type EndpointConfig } from "../endpoints.js";
import { DiscoveryError } from "../errors.js";

/** Resolved OAuth endpoints plus the resource identifiers for each RoboNet surface (API, MCP, WebSocket). */
export interface OAuthDiscovery {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly registrationEndpoint: string;
  readonly mcpResource: string;
  readonly apiResource: string | null;
  readonly websocketResource: string | null;
}

/** Return the resource identifier to request for a WebSocket token, falling back to the API resource. Throws {@link DiscoveryError} if neither is available. */
export function websocketOrApiResource(discovery: OAuthDiscovery): string {
  if (discovery.websocketResource) return discovery.websocketResource;
  if (discovery.apiResource) return discovery.apiResource;
  throw new DiscoveryError(
    "OAuth discovery did not provide an API or websocket resource.",
  );
}

function origin(url: string): string {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}`;
}

/**
 * Perform OAuth 2.0 discovery by fetching the protected-resource and
 * authorization-server metadata documents. Throws {@link DiscoveryError} on
 * network failure or missing required metadata fields.
 */
export async function discoverOAuth(
  endpoints: EndpointConfig,
): Promise<OAuthDiscovery> {
  const protectedResourceUrl = `${endpoints.apiBaseUrl.replace(/\/+$/, "")}/.well-known/oauth-protected-resource`;
  const authorizationServerUrl = `${endpoints.authBaseUrl.replace(/\/+$/, "")}/.well-known/oauth-authorization-server`;

  let protectedBody: Record<string, unknown>;
  let authBody: Record<string, unknown>;

  try {
    const protectedResponse = await fetch(protectedResourceUrl, {
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (protectedResponse.status !== 200) {
      throw new DiscoveryError(
        `OAuth discovery failed: ${protectedResourceUrl} returned ${protectedResponse.status}`,
      );
    }
    protectedBody = (await protectedResponse.json()) as Record<string, unknown>;

    const authResponse = await fetch(authorizationServerUrl, {
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (authResponse.status !== 200) {
      throw new DiscoveryError(
        `OAuth discovery failed: ${authorizationServerUrl} returned ${authResponse.status}`,
      );
    }
    authBody = (await authResponse.json()) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof DiscoveryError) throw err;
    throw new DiscoveryError(`OAuth discovery failed: ${err}`);
  }

  const apiResource = String(protectedBody.resource ?? "").replace(/\/+$/, "");
  if (!apiResource) {
    throw new DiscoveryError(
      "OAuth discovery failed: protected-resource metadata did not include a resource value",
    );
  }

  const authorizationEndpoint = String(authBody.authorization_endpoint ?? "").replace(/\/+$/, "");
  const tokenEndpoint = String(authBody.token_endpoint ?? "").replace(/\/+$/, "");
  const registrationEndpoint = String(authBody.registration_endpoint ?? "").replace(/\/+$/, "");

  if (!authorizationEndpoint) {
    throw new DiscoveryError(
      "OAuth discovery failed: authorization server metadata did not include authorization_endpoint",
    );
  }
  if (!tokenEndpoint) {
    throw new DiscoveryError(
      "OAuth discovery failed: authorization server metadata did not include token_endpoint",
    );
  }
  if (!registrationEndpoint) {
    throw new DiscoveryError(
      "OAuth discovery failed: authorization server metadata did not include registration_endpoint",
    );
  }

  const mcpOrigin = origin(endpoints.mcpBaseUrl);
  const wsOrigin = origin(endpoints.websocketUrl);
  let mcpResource: string | null = null;
  let websocketResource: string | null = null;

  const resourceServers = authBody.resource_servers;
  if (Array.isArray(resourceServers)) {
    for (const rs of resourceServers) {
      if (typeof rs !== "object" || rs === null) continue;
      const record = rs as Record<string, unknown>;
      const resourceId = String(record.resource ?? "").replace(/\/+$/, "");
      const resourceOrigin = origin(resourceId);
      if (!mcpResource && resourceOrigin === mcpOrigin) {
        mcpResource = resourceId;
      } else if (!websocketResource && resourceOrigin === wsOrigin) {
        websocketResource = resourceId;
      }
    }
  }

  if (!mcpResource) {
    mcpResource = endpoints.mcpBaseUrl.replace(/\/+$/, "");
  }

  return {
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint,
    mcpResource,
    apiResource,
    websocketResource,
  };
}
