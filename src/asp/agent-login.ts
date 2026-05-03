import { requestClientCredentialsToken } from "../auth/client-credentials.js";
import { discoverOAuth } from "../auth/discovery.js";
import {
  performAgentPkceLogin,
  requestRefreshTokenExchange,
} from "../auth/pkce.js";
import type { CLIConfig } from "../config.js";
import { openProcessCredentialStore } from "../credentials/lifecycle.js";
import { RobotNetCLIError } from "../errors.js";

/**
 * Agent enrollment and renewal flows.
 *
 * Two paths today:
 *   - `client_credentials`: generated on the website ("Generate credentials"),
 *     stored long-term in `agent_credentials.client_id` / `client_secret`,
 *     re-minted on demand when the cached access token expires.
 *   - `pkce`: stub. Lands once auth.robotnet.ai' agent-PKCE endpoint
 *     stabilises (see migration.bot's note on the in-flight `/authorize`
 *     reshape).
 *
 * All flows write through the same `agent_credentials` table, discriminated
 * by `kind`. The `auth-resolver` calls into renewal lazily — each command
 * pays the latency only when the cached bearer is within the grace window
 * of expiry.
 */

export interface MintedAgentToken {
  readonly bearer: string;
  /** Epoch ms at which the bearer expires; null if the issuer didn't say. */
  readonly bearerExpiresAt: number | null;
  readonly scope: string | null;
}

/**
 * Run the OAuth `client_credentials` grant against the configured network's
 * issuer and return the minted bearer.
 */
async function mintViaClientCredentials(args: {
  readonly config: CLIConfig;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly scope?: string;
}): Promise<MintedAgentToken> {
  const discovery = await discoverOAuth(args.config.endpoints);
  const resource =
    discovery.apiResource ?? args.config.endpoints.apiBaseUrl.replace(/\/+$/, "");
  const response = await requestClientCredentialsToken({
    tokenEndpoint: discovery.tokenEndpoint,
    clientId: args.clientId,
    clientSecret: args.clientSecret,
    resource,
    ...(args.scope !== undefined ? { scope: args.scope } : {}),
  });
  const bearerExpiresAt =
    response.expiresIn !== null ? Date.now() + response.expiresIn * 1000 : null;
  return {
    bearer: response.accessToken,
    bearerExpiresAt,
    scope: response.scope,
  };
}

/**
 * Enroll an agent via `client_credentials` and persist the row. Called from
 * `robotnet login --agent <handle> --client-id ... --client-secret ...`.
 */
export async function enrollAgentClientCredentials(args: {
  readonly config: CLIConfig;
  readonly handle: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly scope?: string;
}): Promise<MintedAgentToken> {
  const minted = await mintViaClientCredentials({
    config: args.config,
    clientId: args.clientId,
    clientSecret: args.clientSecret,
    scope: args.scope,
  });
  const store = await openProcessCredentialStore(args.config);
  store.putAgentCredential({
    networkName: args.config.network.name,
    handle: args.handle,
    kind: "oauth_client_credentials",
    bearer: minted.bearer,
    bearerExpiresAt: minted.bearerExpiresAt,
    clientId: args.clientId,
    clientSecret: args.clientSecret,
    scope: minted.scope,
  });
  return minted;
}

/**
 * Re-mint an `oauth_client_credentials` agent's bearer using the stored
 * `client_id`/`client_secret`, and update the row. Returns the fresh bearer.
 *
 * Called by the auth-resolver when a cached bearer is within the grace
 * window of its `bearerExpiresAt`.
 */
export async function renewAgentClientCredentials(args: {
  readonly config: CLIConfig;
  readonly handle: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly scope: string | null;
}): Promise<string> {
  const minted = await mintViaClientCredentials({
    config: args.config,
    clientId: args.clientId,
    clientSecret: args.clientSecret,
    ...(args.scope !== null ? { scope: args.scope } : {}),
  });
  const store = await openProcessCredentialStore(args.config);
  store.putAgentCredential({
    networkName: args.config.network.name,
    handle: args.handle,
    kind: "oauth_client_credentials",
    bearer: minted.bearer,
    bearerExpiresAt: minted.bearerExpiresAt,
    clientId: args.clientId,
    clientSecret: args.clientSecret,
    scope: minted.scope,
  });
  return minted.bearer;
}

/**
 * Enroll an agent via the OAuth `authorization_code` grant with PKCE.
 *
 * Flow:
 * 1. Discover the auth server's endpoints (cached by the credential
 *    store's lifecycle, but cheap to re-fetch).
 * 2. Run the same browser-redirect PKCE we use for user login, but with
 *    `agent_handle=<handle>` on the authorization URL — the auth server
 *    issues an agent-scoped token rather than a user-scoped one.
 * 3. Persist the access + refresh tokens in `agent_credentials` keyed by
 *    `(network_name, handle)` with `kind = oauth_pkce`. The auth-resolver
 *    handles renewal via the refresh token when the cached bearer is
 *    within the grace window of expiry.
 *
 * Returns the minted access token + expiry in case the caller wants to
 * print it or feed it into a subsequent operation.
 */
export interface EnrolledAgentPkce {
  readonly bearer: string;
  readonly bearerExpiresAt: number | null;
  readonly scope: string | null;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly tokenEndpoint: string;
}

export async function enrollAgentPkce(args: {
  readonly config: CLIConfig;
  readonly handle: string;
  readonly scope?: string;
}): Promise<EnrolledAgentPkce> {
  const discovery = await discoverOAuth(args.config.endpoints);
  const result = await performAgentPkceLogin({
    endpoints: args.config.endpoints,
    discovery,
    agentHandle: args.handle,
    ...(args.scope !== undefined ? { scope: args.scope } : {}),
  });
  const bearerExpiresAt =
    result.token.expiresIn !== null ? Date.now() + result.token.expiresIn * 1000 : null;

  const store = await openProcessCredentialStore(args.config);
  store.putAgentCredential({
    networkName: args.config.network.name,
    handle: args.handle,
    kind: "oauth_pkce",
    bearer: result.token.accessToken,
    bearerExpiresAt,
    refreshToken: result.refreshToken,
    // Persist the public client_id so refresh-token renewal can replay
    // against the same client the original code was issued to. PKCE
    // refreshes fail otherwise.
    clientId: result.clientId,
    scope: result.token.scope,
  });

  return {
    bearer: result.token.accessToken,
    bearerExpiresAt,
    scope: result.token.scope,
    clientId: result.clientId,
    redirectUri: result.redirectUri,
    tokenEndpoint: result.tokenEndpoint,
  };
}

/**
 * Re-mint an `oauth_pkce` agent's bearer using the stored refresh token
 * and the original client_id, then update the row.
 *
 * Called by the auth-resolver when the cached bearer is within the grace
 * window of `bearerExpiresAt`. Refresh tokens rotate per RFC 6749 §6 —
 * the new refresh token replaces the old one in the credential row.
 */
export async function renewAgentPkce(args: {
  readonly config: CLIConfig;
  readonly handle: string;
  readonly clientId: string;
  readonly refreshToken: string;
  readonly scope: string | null;
}): Promise<string> {
  const discovery = await discoverOAuth(args.config.endpoints);
  const resource =
    discovery.apiResource ?? args.config.endpoints.apiBaseUrl.replace(/\/+$/, "");
  const exchanged = await requestRefreshTokenExchange({
    tokenEndpoint: discovery.tokenEndpoint,
    clientId: args.clientId,
    refreshToken: args.refreshToken,
    resource,
    scope: args.scope ?? "",
  });
  const bearerExpiresAt =
    exchanged.token.expiresIn !== null
      ? Date.now() + exchanged.token.expiresIn * 1000
      : null;
  const store = await openProcessCredentialStore(args.config);
  store.putAgentCredential({
    networkName: args.config.network.name,
    handle: args.handle,
    kind: "oauth_pkce",
    bearer: exchanged.token.accessToken,
    bearerExpiresAt,
    refreshToken: exchanged.refreshToken,
    clientId: args.clientId,
    scope: exchanged.token.scope ?? args.scope,
  });
  return exchanged.token.accessToken;
}

/**
 * Cached bearer is "still valid" if it has at least 30 seconds of life left.
 * Bearers without a known expiry (issuer didn't return `expires_in`) are
 * always considered valid — there's no better signal locally.
 */
export const BEARER_GRACE_MS = 30_000;

export function bearerStillValid(bearerExpiresAt: number | null): boolean {
  if (bearerExpiresAt === null) return true;
  return bearerExpiresAt > Date.now() + BEARER_GRACE_MS;
}
