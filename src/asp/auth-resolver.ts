import { requestRefreshTokenExchange } from "../auth/pkce.js";
import type { CLIConfig } from "../config.js";
import { CredentialDecryptionError } from "../credentials/aes-encryptor.js";
import { openProcessCredentialStore } from "../credentials/lifecycle.js";
import type { CredentialStore } from "../credentials/store.js";
import { FatalAuthError, RobotNetCLIError } from "../errors.js";
import { AspAdminClient } from "./admin-client.js";
import {
  bearerStillValid,
  renewAgentClientCredentials,
  renewAgentPkce,
} from "./agent-login.js";
import { LocalAdminTokenNotFoundError, CredentialNotFoundError } from "./credentials.js";
import { AspSessionClient } from "./session-client.js";

/**
 * Single seam for resolving the bearer tokens an ASP command needs.
 *
 * Lookup order:
 *   1. The `--local-admin-token` / `--token` override flag (explicit dev escape hatch).
 *   2. The shared SQLite credential store. For OAuth-issued agent tokens,
 *      bearers within the grace window of expiry are silently renewed using
 *      the row's stored renewal material (refresh_token for PKCE,
 *      client_id+client_secret for client_credentials).
 *
 * Legacy file-based credentials are ingested into the store on first open
 * per process (see `src/credentials/lifecycle.ts`); after that, the store
 * is the only source of truth.
 */

export type TokenSource = "flag" | "store";

export interface ResolvedToken {
  readonly token: string;
  readonly source: TokenSource;
}

export async function resolveAdminToken(
  config: CLIConfig,
  override?: string,
): Promise<ResolvedToken> {
  if (override !== undefined && override.length > 0) {
    return { token: override, source: "flag" };
  }
  const store = await openProcessCredentialStore(config);
  let stored: ReturnType<CredentialStore["getLocalAdminToken"]>;
  try {
    stored = store.getLocalAdminToken(config.network.name);
  } catch (err) {
    if (err instanceof CredentialDecryptionError) {
      handleKeyChangeRecovery(store, "local admin token", config.network.name);
    }
    throw err;
  }
  if (stored !== null) {
    return { token: stored.token, source: "store" };
  }
  throw new LocalAdminTokenNotFoundError(config.network.name);
}

export async function resolveAdminClient(
  config: CLIConfig,
  override?: string,
): Promise<AspAdminClient> {
  const { token } = await resolveAdminToken(config, override);
  return new AspAdminClient(config.network.url, token);
}

export async function resolveAgentToken(
  config: CLIConfig,
  handle: string,
  override?: string,
): Promise<ResolvedToken> {
  if (override !== undefined && override.length > 0) {
    return { token: override, source: "flag" };
  }
  const store = await openProcessCredentialStore(config);
  let stored: ReturnType<CredentialStore["getAgentCredential"]>;
  try {
    stored = store.getAgentCredential(config.network.name, handle);
  } catch (err) {
    if (err instanceof CredentialDecryptionError) {
      handleKeyChangeRecovery(store, `agent credential for ${handle}`, config.network.name);
    }
    throw err;
  }
  if (stored === null) {
    throw new CredentialNotFoundError(handle, config.network.name);
  }

  switch (stored.kind) {
    case "local_bearer":
      // Long-lived bearers issued by `admin agent create` on a local
      // network. No expiry, no renewal.
      return { token: stored.bearer, source: "store" };

    case "oauth_pkce": {
      if (bearerStillValid(stored.bearerExpiresAt)) {
        return { token: stored.bearer, source: "store" };
      }
      if (stored.refreshToken === null || stored.clientId === null) {
        // Defensive: the credential row should always have both for
        // oauth_pkce (validate gates inserts), but a hand-edited DB or a
        // future schema migration could leave them sparse.
        throw new RobotNetCLIError(
          `agent ${handle}'s PKCE bearer has expired and the row is missing renewal material. ` +
            `Re-run \`robotnet login --agent ${handle}\` to enroll afresh.`,
        );
      }
      const refreshed = await renewAgentPkce({
        config,
        handle,
        clientId: stored.clientId,
        refreshToken: stored.refreshToken,
        scope: stored.scope,
      });
      return { token: refreshed, source: "store" };
    }

    case "oauth_client_credentials": {
      if (bearerStillValid(stored.bearerExpiresAt)) {
        return { token: stored.bearer, source: "store" };
      }
      if (stored.clientId === null || stored.clientSecret === null) {
        // Should never happen — `validateInput` guarantees both are set
        // for this kind on insert. Defensive check in case the row was
        // hand-edited or migrated from a different schema.
        throw new RobotNetCLIError(
          `agent ${handle}'s client_credentials row is missing the client_id/secret needed to refresh. ` +
            `Re-run \`robotnet login --agent ${handle} --client-id <id> --client-secret <secret>\`.`,
        );
      }
      const refreshed = await renewAgentClientCredentials({
        config,
        handle,
        clientId: stored.clientId,
        clientSecret: stored.clientSecret,
        scope: stored.scope,
      });
      return { token: refreshed, source: "store" };
    }

    default: {
      const _exhaustive: never = stored.kind;
      throw new RobotNetCLIError(
        `unhandled agent credential kind: ${String(_exhaustive)}`,
      );
    }
  }
}

export async function resolveSessionClient(
  config: CLIConfig,
  handle: string,
  override?: string,
): Promise<AspSessionClient> {
  const { token } = await resolveAgentToken(config, handle, override);
  return new AspSessionClient(config.network.url, websocketUrlFor(config), token);
}

/**
 * Resolve the WebSocket handshake URL for the active network.
 *
 * `oauth` networks front the WebSocket on a dedicated gateway whose origin
 * may differ from the REST API's — the network's `websocketUrl` field is
 * the authoritative source. Use it as-is.
 *
 * `agent-token` networks (e.g. `robotnet network start` running the local
 * Node operator) serve REST and WS on the same host with WS at `/connect`.
 * For those, promote the REST URL's scheme and append the path.
 */
function websocketUrlFor(config: CLIConfig): string {
  if (config.network.authMode === "oauth") {
    if (!config.network.websocketUrl) {
      throw new RobotNetCLIError(
        `Network "${config.network.name}" has auth_mode=oauth but no websocket_url configured.`,
      );
    }
    return config.network.websocketUrl;
  }
  return `${config.network.url.replace(/^http/, "ws")}/connect`;
}

/**
 * Resolve the human user's session bearer for account-scoped routes
 * (`robotnet account ...`).
 *
 * Read order:
 *   1. The shared user_session row in the credential store. If absent →
 *      "not logged in" — the user must run `robotnet account login` first.
 *   2. If the cached access token is within the grace window of expiry,
 *      exchange the stored refresh token at the original token endpoint
 *      and persist the rotated credential. Refresh failures from the auth
 *      server (4xx) wipe the user_session and surface a clean
 *      "session invalid — re-login" message; transient failures (408/429/5xx)
 *      bubble unchanged so the caller can retry.
 *
 * Distinct from {@link resolveAgentToken}: agent credentials live in
 * `agent_credentials` keyed by (network, handle); the user session is a
 * profile-wide singleton that only authorizes account-scoped routes.
 * Callers must NOT use the user bearer to authenticate ASP `/sessions`
 * traffic — that's agent-bearer territory and the operator rejects mixed
 * flavors.
 */
export async function resolveUserToken(config: CLIConfig): Promise<ResolvedToken> {
  const store = await openProcessCredentialStore(config);
  let session: ReturnType<CredentialStore["getUserSession"]>;
  try {
    session = store.getUserSession();
  } catch (err) {
    if (err instanceof CredentialDecryptionError) {
      handleKeyChangeRecovery(store, "user session", config.network.name);
    }
    throw err;
  }
  if (session === null) {
    throw new RobotNetCLIError(
      "Not logged in — run `robotnet account login` to authenticate as the calling account.",
    );
  }

  if (bearerStillValid(session.accessTokenExpiresAt)) {
    return { token: session.accessToken, source: "store" };
  }

  if (
    session.refreshToken === null ||
    session.authMode !== "pkce" ||
    session.clientId === null
  ) {
    // Either the refresh material is missing (legacy session, or a
    // client_credentials user session — which doesn't carry a refresh
    // token by design) or the issuing client_id wasn't persisted. Either
    // way, we can't silently renew.
    throw new RobotNetCLIError(
      "User session expired and cannot be refreshed — run `robotnet account login` to re-authenticate.",
    );
  }

  let exchanged: Awaited<ReturnType<typeof requestRefreshTokenExchange>>;
  try {
    exchanged = await requestRefreshTokenExchange({
      tokenEndpoint: session.tokenEndpoint,
      clientId: session.clientId,
      refreshToken: session.refreshToken,
      resource: session.resource ?? "",
      scope: session.scope ?? "",
    });
  } catch (err) {
    if (err instanceof FatalAuthError) {
      // Refresh-token family was rejected by the auth server. The stored
      // session is dead — wipe it so the next invocation gives a clean
      // "not logged in" instead of looping on a doomed credential.
      store.deleteUserSession();
      throw new RobotNetCLIError(
        "User session refresh was rejected by the auth server — run `robotnet account login` to re-authenticate.",
      );
    }
    throw err;
  }

  const accessTokenExpiresAt =
    exchanged.token.expiresIn !== null
      ? Date.now() + exchanged.token.expiresIn * 1000
      : null;
  store.putUserSession({
    accessToken: exchanged.token.accessToken,
    idToken: session.idToken,
    refreshToken: exchanged.refreshToken,
    accessTokenExpiresAt,
    idTokenExpiresAt: session.idTokenExpiresAt,
    scope: exchanged.token.scope ?? session.scope,
    clientId: session.clientId,
    tokenEndpoint: session.tokenEndpoint,
    resource: session.resource,
    redirectUri: session.redirectUri,
    authMode: session.authMode,
  });

  return { token: exchanged.token.accessToken, source: "store" };
}

/**
 * Wipe every row whose ciphertext can no longer be decrypted (typical cause:
 * the OS keychain key was reset) and throw a clean, actionable error.
 *
 * Without this, a key reset leaves the user with `CredentialDecryptionError`
 * thrown from every CLI invocation forever — an obscure failure mode they
 * can't recover from short of `rm credentials.sqlite`. This way they see
 * one clear message and a clean store to re-register against.
 */
function handleKeyChangeRecovery(
  store: CredentialStore,
  whatWeWereReading: string,
  networkName: string,
): never {
  const purged = store.purgeUnreadableRows();
  throw new RobotNetCLIError(
    `cannot decrypt the stored ${whatWeWereReading} on network "${networkName}". ` +
      `The OS keychain key was likely reset since these credentials were stored. ` +
      `Cleared ${purged.localAdminTokens} local admin token(s) and ${purged.agentCredentials} agent credential(s) ` +
      `that were no longer readable — re-register agents and re-login to restore access.`,
  );
}
