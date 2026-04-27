import type { AgentIdentity } from "../api/models.js";
import { agentIdentityFromPayload } from "../api/models.js";
import type { TokenResponse } from "./client-credentials.js";
import {
  DEFAULT_SCOPES,
  requestClientCredentialsToken,
} from "./client-credentials.js";
import type { OAuthDiscovery } from "./discovery.js";
import { discoverOAuth, websocketOrApiResource } from "./discovery.js";
import { requestRefreshTokenExchange } from "./pkce.js";
import {
  deleteToken,
  isTokenExpired,
  loadToken,
  saveToken,
  type StoredToken,
  storedTokenFromPkceLogin,
} from "./token-store.js";
import { REQUEST_TIMEOUT_MS, type EndpointConfig } from "../endpoints.js";
import { AuthenticationError, FatalAuthError } from "../errors.js";
import type { ListenerSession } from "../realtime/listener.js";

/**
 * Run a refresh-token exchange and translate a `FatalAuthError` into a deleted
 * stored token plus a user-actionable error. Any other error type passes
 * through unchanged so the caller can apply transient-error handling.
 */
async function refreshOrInvalidate<T>(
  tokenStorePath: string,
  exchange: () => Promise<T>,
): Promise<T> {
  try {
    return await exchange();
  } catch (err) {
    if (err instanceof FatalAuthError) {
      deleteToken(tokenStorePath);
      throw new FatalAuthError(
        `${err.message}. Stored RoboNet login has been cleared; run \`robonet login\` to re-authenticate.`,
      );
    }
    throw err;
  }
}

/**
 * Resolve a complete listener session (API token, WebSocket token, and agent identity)
 * from whichever credentials are available: stored PKCE login (refreshed if needed)
 * or client credentials. Throws {@link AuthenticationError} if no usable credentials are found.
 */
export async function resolveRuntimeSession(options: {
  endpoints: EndpointConfig;
  tokenStorePath: string;
  clientId: string | null;
  clientSecret: string | null;
  scope?: string;
}): Promise<ListenerSession> {
  const { endpoints, tokenStorePath, clientId, clientSecret, scope = DEFAULT_SCOPES } = options;
  const discovery = await discoverOAuth(endpoints);
  const stored = loadToken(tokenStorePath);

  if (stored && stored.authMode === "pkce" && stored.refreshToken) {
    if (clientId !== null && clientId !== stored.clientId) {
      throw new AuthenticationError(
        "The provided client ID does not match the stored RoboNet login.",
      );
    }
    return resolvePkceSession({
      endpoints,
      discovery,
      stored,
      tokenStorePath,
      scope,
    });
  }

  if (clientId && clientSecret) {
    return resolveClientCredentialsSession({
      endpoints,
      discovery,
      clientId,
      clientSecret,
      scope,
    });
  }

  if (stored && stored.authMode === "client_credentials") {
    throw new AuthenticationError(
      "Stored login metadata was created with client credentials. " +
        "Run the command again with --client-id and --client-secret, " +
        "or use `robonet login` for browser-based OAuth.",
    );
  }

  throw new AuthenticationError(
    "No usable stored login found. Run `robonet login` first, " +
      "or provide --client-id and --client-secret.",
  );
}

/**
 * Resolve a bearer token scoped to the MCP resource, refreshing a stored PKCE
 * login or performing a client-credentials exchange as needed. Throws
 * {@link AuthenticationError} if no usable credentials are found.
 */
export async function resolveMcpBearerToken(options: {
  endpoints: EndpointConfig;
  tokenStorePath: string;
  clientId: string | null;
  clientSecret: string | null;
  scope?: string;
}): Promise<TokenResponse> {
  const { endpoints, tokenStorePath, clientId, clientSecret, scope = DEFAULT_SCOPES } = options;
  const discovery = await discoverOAuth(endpoints);
  const stored = loadToken(tokenStorePath);

  if (stored && stored.authMode === "pkce" && stored.refreshToken) {
    if (clientId !== null && clientId !== stored.clientId) {
      throw new AuthenticationError(
        "The provided client ID does not match the stored RoboNet login.",
      );
    }
    const { token, refreshToken } = await refreshOrInvalidate(tokenStorePath, () =>
      requestRefreshTokenExchange({
        tokenEndpoint: stored.tokenEndpoint,
        clientId: stored.clientId,
        refreshToken: stored.refreshToken!,
        resource: discovery.mcpResource,
        scope,
      }),
    );
    const refreshed = storedTokenFromPkceLogin({
      token,
      tokenEndpoint: stored.tokenEndpoint,
      clientId: stored.clientId,
      refreshToken,
      redirectUri: stored.redirectUri ?? "",
    });
    saveToken(tokenStorePath, refreshed);
    return token;
  }

  if (clientId && clientSecret) {
    return requestClientCredentialsToken({
      tokenEndpoint: discovery.tokenEndpoint,
      clientId,
      clientSecret,
      resource: discovery.mcpResource,
      scope,
    });
  }

  throw new AuthenticationError(
    "No usable stored login found for MCP access. Run `robonet login` first, " +
      "or provide --client-id and --client-secret.",
  );
}

/**
 * Resolve a bearer token scoped to the REST API resource. Reuses a non-expired
 * stored token without hitting the network; otherwise refreshes or performs a
 * client-credentials exchange. Throws {@link AuthenticationError} if no usable
 * credentials are found.
 */
export async function resolveApiBearerToken(options: {
  endpoints: EndpointConfig;
  tokenStorePath: string;
  clientId: string | null;
  clientSecret: string | null;
  scope?: string;
}): Promise<TokenResponse> {
  const { endpoints, tokenStorePath, clientId, clientSecret, scope = DEFAULT_SCOPES } = options;
  const stored = loadToken(tokenStorePath);

  if (stored && stored.authMode === "pkce" && stored.refreshToken) {
    if (clientId !== null && clientId !== stored.clientId) {
      throw new AuthenticationError(
        "The provided client ID does not match the stored RoboNet login.",
      );
    }
    if (!isTokenExpired(stored)) {
      return tokenResponseFromStored(stored);
    }
    const discovery = await discoverOAuth(endpoints);
    const apiResource = discovery.apiResource ?? endpoints.apiBaseUrl.replace(/\/+$/, "");
    const { token, refreshToken } = await refreshOrInvalidate(tokenStorePath, () =>
      requestRefreshTokenExchange({
        tokenEndpoint: stored.tokenEndpoint,
        clientId: stored.clientId,
        refreshToken: stored.refreshToken!,
        resource: apiResource,
        scope,
      }),
    );
    const refreshed = storedTokenFromPkceLogin({
      token,
      tokenEndpoint: stored.tokenEndpoint,
      clientId: stored.clientId,
      refreshToken,
      redirectUri: stored.redirectUri ?? "",
    });
    saveToken(tokenStorePath, refreshed);
    return token;
  }

  if (clientId && clientSecret) {
    const discovery = await discoverOAuth(endpoints);
    const apiResource = discovery.apiResource ?? endpoints.apiBaseUrl.replace(/\/+$/, "");
    return requestClientCredentialsToken({
      tokenEndpoint: discovery.tokenEndpoint,
      clientId,
      clientSecret,
      resource: apiResource,
      scope,
    });
  }

  if (stored && stored.authMode === "client_credentials") {
    throw new AuthenticationError(
      "Stored login metadata was created with client credentials. " +
        "Run the command again with --client-id and --client-secret, " +
        "or use `robonet login` for browser-based OAuth.",
    );
  }

  throw new AuthenticationError(
    "No usable stored login found. Run `robonet login` first, " +
      "or provide --client-id and --client-secret.",
  );
}

async function resolveClientCredentialsSession(options: {
  endpoints: EndpointConfig;
  discovery: OAuthDiscovery;
  clientId: string;
  clientSecret: string;
  scope: string;
}): Promise<ListenerSession> {
  const { endpoints, discovery, clientId, clientSecret, scope } = options;
  const apiResource = discovery.apiResource ?? endpoints.apiBaseUrl.replace(/\/+$/, "");
  const wsResource = websocketOrApiResource(discovery);

  const apiToken = await requestClientCredentialsToken({
    tokenEndpoint: discovery.tokenEndpoint,
    clientId,
    clientSecret,
    resource: apiResource,
    scope,
  });
  const websocketToken = await requestClientCredentialsToken({
    tokenEndpoint: discovery.tokenEndpoint,
    clientId,
    clientSecret,
    resource: wsResource,
    scope,
  });

  const identity = await resolveIdentity(endpoints.apiBaseUrl, apiToken.accessToken);
  return { discovery, apiToken, websocketToken, identity };
}

async function resolvePkceSession(options: {
  endpoints: EndpointConfig;
  discovery: OAuthDiscovery;
  stored: StoredToken;
  tokenStorePath: string;
  scope: string;
}): Promise<ListenerSession> {
  const { endpoints, discovery, stored, tokenStorePath, scope } = options;
  if (!stored.refreshToken) {
    throw new AuthenticationError("Stored PKCE login is missing a refresh token.");
  }
  const apiResource = discovery.apiResource ?? endpoints.apiBaseUrl.replace(/\/+$/, "");
  const wsResource = websocketOrApiResource(discovery);

  if (!isTokenExpired(stored)) {
    const wsResult = await refreshOrInvalidate(tokenStorePath, () =>
      requestRefreshTokenExchange({
        tokenEndpoint: stored.tokenEndpoint,
        clientId: stored.clientId,
        refreshToken: stored.refreshToken!,
        resource: wsResource,
        scope,
      }),
    );
    saveToken(tokenStorePath, {
      ...stored,
      refreshToken: wsResult.refreshToken,
    });

    const apiToken = tokenResponseFromStored(stored);
    const identity = await resolveIdentity(endpoints.apiBaseUrl, apiToken.accessToken);
    return { discovery, apiToken, websocketToken: wsResult.token, identity };
  }

  const apiResult = await refreshOrInvalidate(tokenStorePath, () =>
    requestRefreshTokenExchange({
      tokenEndpoint: stored.tokenEndpoint,
      clientId: stored.clientId,
      refreshToken: stored.refreshToken!,
      resource: apiResource,
      scope,
    }),
  );
  const wsResult = await refreshOrInvalidate(tokenStorePath, () =>
    requestRefreshTokenExchange({
      tokenEndpoint: stored.tokenEndpoint,
      clientId: stored.clientId,
      refreshToken: apiResult.refreshToken,
      resource: wsResource,
      scope,
    }),
  );

  const refreshed = storedTokenFromPkceLogin({
    token: apiResult.token,
    tokenEndpoint: stored.tokenEndpoint,
    clientId: stored.clientId,
    refreshToken: wsResult.refreshToken,
    redirectUri: stored.redirectUri ?? "",
  });
  saveToken(tokenStorePath, refreshed);

  const identity = await resolveIdentity(endpoints.apiBaseUrl, apiResult.token.accessToken);
  return { discovery, apiToken: apiResult.token, websocketToken: wsResult.token, identity };
}

function tokenResponseFromStored(stored: StoredToken): TokenResponse {
  return {
    accessToken: stored.accessToken,
    tokenType: stored.tokenType,
    expiresIn: stored.expiresIn,
    scope: stored.scope,
    resource: stored.resource,
  };
}

async function resolveIdentity(
  apiBaseUrl: string,
  bearerToken: string,
): Promise<AgentIdentity> {
  const url = `${apiBaseUrl.replace(/\/+$/, "")}/agents/me`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${bearerToken}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status >= 400) {
    throw new AuthenticationError(
      `Failed to resolve agent identity (${response.status}): ${await response.text()}`,
    );
  }
  const payload = (await response.json()) as Record<string, unknown>;
  return agentIdentityFromPayload(payload, "listener");
}
