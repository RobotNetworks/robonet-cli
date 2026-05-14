import { requestClientCredentialsToken } from "../auth/client-credentials.js";
import { collectResources, discoverOAuth } from "../auth/discovery.js";
import {
  performAgentPkceLogin,
  requestRefreshTokenExchange,
} from "../auth/pkce.js";
import type { CLIConfig } from "../config.js";
import { openProcessCredentialStore } from "../credentials/lifecycle.js";
import { RobotNetCLIError } from "../errors.js";
import { assertValidHandle } from "./handles.js";

/**
 * Agent enrollment and renewal flows.
 *
 * Two paths today:
 *   - `client_credentials`: generated on the website ("Generate credentials"),
 *     stored long-term in `agent_credentials.client_id` / `client_secret`,
 *     re-minted on demand when the cached access token expires.
 *   - `pkce`: interactive agent login, persisted with refresh material once
 *     the issuer returns an agent-scoped token.
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
  const discovery = await discoverOAuth(args.config.network);
  const resource =
    discovery.apiResource ?? args.config.network.url.replace(/\/+$/, "");
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
  /** Canonical handle the credential was stored under. For
   *  ``enrollAgentPkce`` this matches the input handle; for
   *  ``enrollAgentPkceViaPicker`` it's the agent the user picked in the
   *  browser. */
  readonly handle: string;
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
  const discovery = await discoverOAuth(args.config.network);
  const result = await performAgentPkceLogin({
    network: args.config.network,
    discovery,
    target: { kind: "handle", handle: args.handle },
    ...(args.scope !== undefined ? { scope: args.scope } : {}),
  });
  // Defense in depth: the auth server should echo the handle the CLI
  // requested. Compare canonical (``@``-prefixed) forms — the wire form
  // is bare (``owner.agent``) while every CLI-side handle carries the
  // ``@`` prefix, so a strict raw-string compare always mismatches.
  if (result.agentHandle !== null) {
    const echoed = canonicalizeHandle(result.agentHandle);
    if (echoed !== args.handle) {
      throw new RobotNetCLIError(
        `Auth server returned agent_handle=${result.agentHandle} for login of ${args.handle}; refusing to store under mismatched key.`,
      );
    }
  }
  return await persistAgentPkce({
    config: args.config,
    handle: args.handle,
    result,
  });
}

export async function enrollAgentPkceViaPicker(args: {
  readonly config: CLIConfig;
  readonly scope?: string;
}): Promise<EnrolledAgentPkce> {
  const discovery = await discoverOAuth(args.config.network);
  const result = await performAgentPkceLogin({
    network: args.config.network,
    discovery,
    target: { kind: "picker" },
    ...(args.scope !== undefined ? { scope: args.scope } : {}),
  });
  if (!result.agentHandle) {
    // The web ran the picker but the token endpoint didn't surface a
    // handle. Without it we have no key to store under. Treat as a hard
    // server-side bug rather than guessing.
    throw new RobotNetCLIError(
      "Picker login completed but the auth server didn't return an agent_handle. Aborting.",
    );
  }
  return await persistAgentPkce({
    config: args.config,
    handle: canonicalizeHandle(result.agentHandle),
    result,
  });
}

async function persistAgentPkce(args: {
  readonly config: CLIConfig;
  readonly handle: string;
  readonly result: Awaited<ReturnType<typeof performAgentPkceLogin>>;
}): Promise<EnrolledAgentPkce> {
  const { config, handle, result } = args;

  // Cross-check the auth server's self-declared network against the
  // network we resolved locally. A mismatch means the profile wired
  // OAuth endpoints from one network into another's storage key — the
  // exact failure mode that produced the original non-canonical row key
  // ghost row. Older auth servers that don't stamp this field skip the
  // check and we trust local config.
  if (result.network !== null && result.network !== config.network.name) {
    throw new RobotNetCLIError(
      `Auth server identifies as network "${result.network}" but you ran login on network "${config.network.name}". ` +
        `Re-run with \`robotnet --network ${result.network} login --agent ${handle}\`, ` +
        `or fix the endpoints/network mapping in your profile so they agree.`,
    );
  }

  const bearerExpiresAt =
    result.token.expiresIn !== null ? Date.now() + result.token.expiresIn * 1000 : null;

  const store = await openProcessCredentialStore(config);
  store.putAgentCredential({
    networkName: config.network.name,
    handle,
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
    handle,
    bearer: result.token.accessToken,
    bearerExpiresAt,
    scope: result.token.scope,
    clientId: result.clientId,
    redirectUri: result.redirectUri,
    tokenEndpoint: result.tokenEndpoint,
  };
}

/** Convert the auth server's bare wire form (``owner.agent``) to the CLI's
 *  canonical ``@owner.agent`` form. Idempotent — safe to call on a value
 *  that already has the ``@`` prefix. Throws the same shape as
 *  {@link assertValidHandle} for malformed input so callers don't have to
 *  validate twice. */
function canonicalizeHandle(handle: string): string {
  const candidate = handle.startsWith("@") ? handle : `@${handle}`;
  assertValidHandle(candidate);
  return candidate;
}

/* -------------------------------------------------------------------------- */
/* Test-only exports                                                           */
/* -------------------------------------------------------------------------- */

/** Test seam: drives the PKCE persistence path against a synthetic
 *  ``PKCELoginResult`` so tests can exercise normalization and the
 *  network cross-check without mocking the full browser-redirect flow.
 *  Not part of the public API — do not call from non-test code. */
export const _persistAgentPkceForTests = persistAgentPkce;

/** Test seam: exposes the handle canonicalizer so the per-shape behavior
 *  can be verified directly. Not part of the public API. */
export const _canonicalizeHandleForTests = canonicalizeHandle;

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
  const discovery = await discoverOAuth(args.config.network);
  // Refresh must request the same audience set the original token had,
  // otherwise the renewed bearer drops the WebSocket audience and
  // `robotnet listen` 401s on the next reconnect.
  const resources = collectResources(discovery, args.config.network, "agent");
  const exchanged = await requestRefreshTokenExchange({
    tokenEndpoint: discovery.tokenEndpoint,
    clientId: args.clientId,
    refreshToken: args.refreshToken,
    resources,
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
