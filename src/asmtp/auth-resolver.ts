import { requestRefreshTokenExchange } from "../auth/pkce.js";
import type { CLIConfig } from "../config.js";
import { CredentialDecryptionError } from "../credentials/aes-encryptor.js";
import { openProcessCredentialStore } from "../credentials/lifecycle.js";
import { withCredentialRefreshLock } from "../credentials/refresh-lock.js";
import type { AgentCredentialRecord, CredentialStore } from "../credentials/store.js";
import { FatalAuthError, RobotNetCLIError } from "../errors.js";
import { AdminClient } from "./admin-client.js";
import {
  bearerStillValid,
  renewAgentClientCredentials,
  renewAgentPkce,
} from "./agent-login.js";
import { LocalAdminTokenNotFoundError, CredentialNotFoundError } from "./credentials.js";

/**
 * Single seam for resolving the bearer tokens a command needs.
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
): Promise<AdminClient> {
  const { token } = await resolveAdminToken(config, override);
  return new AdminClient(config.network.url, token);
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

  return await resolveStoredAgentToken(config, handle, stored, store);
}

async function resolveStoredAgentToken(
  config: CLIConfig,
  handle: string,
  stored: AgentCredentialRecord,
  store: CredentialStore,
): Promise<ResolvedToken> {
  switch (stored.kind) {
    case "local_bearer":
      // Long-lived bearers issued by `admin agent create` on a local
      // network. No expiry, no renewal.
      return { token: stored.bearer, source: "store" };

    case "oauth_pkce": {
      if (bearerStillValid(stored.bearerExpiresAt)) {
        return { token: stored.bearer, source: "store" };
      }
      return await renewAgentPkceWithLock(config, handle, store);
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

async function renewAgentPkceWithLock(
  config: CLIConfig,
  handle: string,
  store: CredentialStore,
): Promise<ResolvedToken> {
  return await withCredentialRefreshLock(
    config,
    { kind: "agent", networkName: config.network.name, handle },
    async () => {
      let latest: ReturnType<CredentialStore["getAgentCredential"]>;
      try {
        latest = store.getAgentCredential(config.network.name, handle);
      } catch (err) {
        if (err instanceof CredentialDecryptionError) {
          handleKeyChangeRecovery(store, `agent credential for ${handle}`, config.network.name);
        }
        throw err;
      }

      if (latest === null) {
        throw new CredentialNotFoundError(handle, config.network.name);
      }
      if (latest.kind !== "oauth_pkce" || bearerStillValid(latest.bearerExpiresAt)) {
        return await resolveStoredAgentToken(config, handle, latest, store);
      }
      if (latest.refreshToken === null || latest.clientId === null) {
        // Defensive: the credential row should always have both for
        // oauth_pkce (validate gates inserts), but a hand-edited DB or a
        // future schema migration could leave them sparse.
        throw new RobotNetCLIError(
          `agent ${handle}'s PKCE bearer has expired and the row is missing renewal material. ` +
            `Re-run \`robotnet login --agent ${handle}\` to enroll afresh.`,
        );
      }

      try {
        const refreshed = await renewAgentPkce({
          config,
          handle,
          clientId: latest.clientId,
          refreshToken: latest.refreshToken,
          scope: latest.scope,
        });
        return { token: refreshed, source: "store" };
      } catch (err) {
        if (err instanceof FatalAuthError) {
          const current = store.getAgentCredential(config.network.name, handle);
          if (
            current?.kind === "oauth_pkce" &&
            current.refreshToken === latest.refreshToken
          ) {
            store.deleteAgentCredential(config.network.name, handle);
          }
          throw new RobotNetCLIError(
            `agent ${handle}'s stored PKCE refresh token was rejected by the auth server. ` +
              `Cleared the stale credential; run \`robotnet login --agent ${handle} --network ${config.network.name}\` to re-authenticate.`,
          );
        }
        throw err;
      }
    },
  );
}

/** Resolve the agent's bearer plus the network's REST URL. */
export async function resolveAgentBearer(
  config: CLIConfig,
  handle: string,
  override?: string,
): Promise<{ readonly token: string; readonly baseUrl: string }> {
  const { token } = await resolveAgentToken(config, handle, override);
  return { token, baseUrl: config.network.url };
}

/** Resolve the agent's bearer plus the network's WebSocket handshake URL. */
export async function resolveAgentWebsocket(
  config: CLIConfig,
  handle: string,
  override?: string,
): Promise<{ readonly token: string; readonly wsUrl: string }> {
  const { token } = await resolveAgentToken(config, handle, override);
  return { token, wsUrl: websocketUrlFor(config) };
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
 *   1. The shared user_session row in the credential store. If absent,
 *      "not logged in" — the user must run `robotnet account login` first.
 *   2. If the cached access token is within the grace window of expiry,
 *      exchange the stored refresh token at the original token endpoint
 *      and persist the rotated credential. Refresh failures from the auth
 *      server (4xx) wipe the user_session and surface a clean
 *      "session invalid, re-login" message; transient failures (408/429/5xx)
 *      bubble unchanged so the caller can retry.
 *
 * Distinct from {@link resolveAgentToken}: agent credentials live in
 * `agent_credentials` keyed by (network, handle); the user session is a
 * profile-wide singleton that only authorizes account-scoped routes.
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
    // client_credentials user session, which doesn't carry a refresh
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
      resources: [session.resource ?? ""],
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
 * Wipe every row whose ciphertext can no longer be decrypted (typical
 * cause: the credential-store key file was rotated or replaced) and
 * throw a clean, actionable error. Without this, a key change leaves
 * the user with `CredentialDecryptionError` thrown from every CLI
 * invocation forever; one clear message + a clean store is much better.
 */
function handleKeyChangeRecovery(
  store: CredentialStore,
  whatWeWereReading: string,
  networkName: string,
): never {
  const purged = store.purgeUnreadableRows();
  throw new RobotNetCLIError(
    `cannot decrypt the stored ${whatWeWereReading} on network "${networkName}". ` +
      `The credential-store key was likely rotated since these credentials were stored. ` +
      `Cleared ${purged.localAdminTokens} local admin token(s) and ${purged.agentCredentials} agent credential(s) ` +
      `that were no longer readable — re-register agents and re-login to restore access.`,
  );
}
