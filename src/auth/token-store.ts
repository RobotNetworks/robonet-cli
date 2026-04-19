import * as fs from "node:fs";
import * as path from "node:path";
import type { TokenResponse } from "./client-credentials.js";

/**
 * Persisted OAuth credentials written to disk at `auth.json`. Includes both the
 * access token and the metadata needed to refresh it (token endpoint, client ID,
 * refresh token).
 */
export interface StoredToken {
  readonly accessToken: string;
  readonly tokenType: string;
  /** Token lifetime in seconds as reported by the OAuth server (not milliseconds). */
  readonly expiresIn: number | null;
  /** Absolute epoch milliseconds when the access token expires, or null if unknown. */
  readonly expiresAt: number | null;
  readonly scope: string | null;
  readonly resource: string;
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly authMode: "client_credentials" | "pkce";
  readonly refreshToken: string | null;
  readonly redirectUri: string | null;
}

function computeExpiresAt(expiresIn: number | null): number | null {
  if (expiresIn === null || expiresIn <= 0) return null;
  return Date.now() + expiresIn * 1000;
}

/** True if the token is expired or within 30 seconds of expiry (clock-skew buffer). Tokens without `expiresAt` are treated as non-expiring. */
export function isTokenExpired(token: StoredToken): boolean {
  if (token.expiresAt === null) return false;
  // Treat as expired 30 seconds early to avoid edge-case clock skew
  return Date.now() >= token.expiresAt - 30_000;
}

/** Build a {@link StoredToken} from a client-credentials grant; `refreshToken` and `redirectUri` are null because this flow has neither. */
export function storedTokenFromClientCredentials(
  token: TokenResponse,
  tokenEndpoint: string,
  clientId: string,
): StoredToken {
  return {
    accessToken: token.accessToken,
    tokenType: token.tokenType,
    expiresIn: token.expiresIn,
    expiresAt: computeExpiresAt(token.expiresIn),
    scope: token.scope,
    resource: token.resource,
    tokenEndpoint,
    clientId,
    authMode: "client_credentials",
    refreshToken: null,
    redirectUri: null,
  };
}

/** Build a {@link StoredToken} from a PKCE login, carrying the refresh token and redirect URI needed for later refreshes. */
export function storedTokenFromPkceLogin(options: {
  token: TokenResponse;
  tokenEndpoint: string;
  clientId: string;
  refreshToken: string;
  redirectUri: string;
}): StoredToken {
  return {
    accessToken: options.token.accessToken,
    tokenType: options.token.tokenType,
    expiresIn: options.token.expiresIn,
    expiresAt: computeExpiresAt(options.token.expiresIn),
    scope: options.token.scope,
    resource: options.token.resource,
    tokenEndpoint: options.tokenEndpoint,
    clientId: options.clientId,
    authMode: "pkce",
    refreshToken: options.refreshToken,
    redirectUri: options.redirectUri,
  };
}

function storedTokenToJson(token: StoredToken): Record<string, unknown> {
  return {
    access_token: token.accessToken,
    token_type: token.tokenType,
    expires_in: token.expiresIn,
    expires_at: token.expiresAt,
    scope: token.scope,
    resource: token.resource,
    token_endpoint: token.tokenEndpoint,
    client_id: token.clientId,
    auth_mode: token.authMode,
    refresh_token: token.refreshToken,
    redirect_uri: token.redirectUri,
  };
}

/** Persist a token to disk with 0600 permissions (owner read/write only); creates parent directories with 0700. */
export function saveToken(filePath: string, token: StoredToken): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, JSON.stringify(storedTokenToJson(token), null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
}

/** Load a stored token from disk. Returns null if the file is missing, unreadable, malformed JSON, or fails validation. */
export function loadToken(filePath: string): StoredToken | null {
  if (!fs.existsSync(filePath)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }

  const p = payload as Record<string, unknown>;
  const requiredStringKeys = [
    "access_token",
    "token_type",
    "resource",
    "token_endpoint",
    "client_id",
  ] as const;

  for (const key of requiredStringKeys) {
    if (typeof p[key] !== "string" || !p[key]) return null;
  }

  return {
    accessToken: p.access_token as string,
    tokenType: p.token_type as string,
    expiresIn: typeof p.expires_in === "number" ? p.expires_in : null,
    expiresAt: typeof p.expires_at === "number" ? p.expires_at : null,
    scope: typeof p.scope === "string" ? p.scope : null,
    resource: p.resource as string,
    tokenEndpoint: p.token_endpoint as string,
    clientId: p.client_id as string,
    authMode:
      p.auth_mode === "pkce" ? "pkce" : "client_credentials",
    refreshToken: typeof p.refresh_token === "string" ? p.refresh_token : null,
    redirectUri: typeof p.redirect_uri === "string" ? p.redirect_uri : null,
  };
}
