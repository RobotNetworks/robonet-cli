import type { NetworkConfig } from "../config.js";
import { DISCOVERY_TIMEOUT_MS } from "../endpoints.js";
import { DiscoveryError } from "../errors.js";

/** Resolved OAuth endpoints plus the resource identifiers for each Robot Networks surface (API, WebSocket). */
export interface OAuthDiscovery {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly registrationEndpoint: string;
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
 * Perform OAuth 2.0 discovery against the given OAuth network. Throws
 * {@link DiscoveryError} on network failure, missing required metadata
 * fields, or when called against a non-OAuth network (which is a
 * programming error — `agent-token` networks have no OAuth surface).
 */
export async function discoverOAuth(
  network: NetworkConfig,
): Promise<OAuthDiscovery> {
  if (network.authMode !== "oauth") {
    throw new DiscoveryError(
      `OAuth discovery is not applicable to network "${network.name}" (auth_mode=${network.authMode}).`,
    );
  }
  if (!network.authBaseUrl) {
    throw new DiscoveryError(
      `Network "${network.name}" is missing \`auth_base_url\` — cannot perform OAuth discovery.`,
    );
  }
  if (!network.websocketUrl) {
    throw new DiscoveryError(
      `Network "${network.name}" is missing \`websocket_url\` — cannot resolve WebSocket resource.`,
    );
  }

  const protectedResourceUrl = `${network.url.replace(/\/+$/, "")}/.well-known/oauth-protected-resource`;
  const authorizationServerUrl = `${network.authBaseUrl.replace(/\/+$/, "")}/.well-known/oauth-authorization-server`;

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

  const wsOrigin = origin(network.websocketUrl);
  let websocketResource: string | null = null;

  const resourceServers = authBody.resource_servers;
  if (Array.isArray(resourceServers)) {
    for (const rs of resourceServers) {
      if (typeof rs !== "object" || rs === null) continue;
      const record = rs as Record<string, unknown>;
      const resourceId = String(record.resource ?? "").replace(/\/+$/, "");
      const resourceOrigin = origin(resourceId);
      if (!websocketResource && resourceOrigin === wsOrigin) {
        websocketResource = resourceId;
      }
    }
  }

  return {
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint,
    apiResource,
    websocketResource,
  };
}
