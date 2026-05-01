import * as crypto from "node:crypto";
import * as http from "node:http";
import type { TokenResponse } from "./client-credentials.js";
import { tokenResponseFromBody, DEFAULT_SCOPES } from "./client-credentials.js";
import type { OAuthDiscovery } from "./discovery.js";
import type { EndpointConfig } from "../endpoints.js";
import { REQUEST_TIMEOUT_MS } from "../endpoints.js";
import {
  AuthenticationError,
  FatalAuthError,
  TransientAuthError,
} from "../errors.js";

const DEFAULT_LOOPBACK_REDIRECT_URI = "http://127.0.0.1:8788/callback";
const DEFAULT_PUBLIC_CLIENT_NAME = "robotnet-cli";

/** Result of a successful PKCE login: the API access token plus the long-lived data needed to refresh it. */
export interface PKCELoginResult {
  readonly token: TokenResponse;
  readonly refreshToken: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly tokenEndpoint: string;
}

/**
 * Drive a full OAuth 2.0 PKCE browser login: dynamic client registration,
 * authorization URL, loopback callback, and code exchange. Throws
 * {@link AuthenticationError} on user cancel, state mismatch, or network failure.
 */
export async function performPkceLogin(options: {
  endpoints: EndpointConfig;
  discovery: OAuthDiscovery;
  scope?: string;
  redirectUri?: string;
  clientName?: string;
}): Promise<PKCELoginResult> {
  const {
    endpoints,
    discovery,
    scope = DEFAULT_SCOPES,
    redirectUri = DEFAULT_LOOPBACK_REDIRECT_URI,
    clientName = DEFAULT_PUBLIC_CLIENT_NAME,
  } = options;

  const registration = await registerPublicClient({
    registrationEndpoint: discovery.registrationEndpoint,
    clientName,
    redirectUris: [redirectUri],
    scope,
  });
  const clientId = String(registration.client_id);

  const { verifier, challenge } = generatePkcePair();
  const state = crypto.randomUUID().replace(/-/g, "");
  const authorizationUrl = buildAuthorizationUrl({
    authorizationEndpoint: discovery.authorizationEndpoint,
    clientId,
    redirectUri,
    codeChallenge: challenge,
    scope,
    state,
  });

  console.log("Opening browser for RobotNet login and agent selection.");
  console.log(authorizationUrl);
  const open = (await import("open")).default;
  await open(authorizationUrl);

  const code = await waitForOAuthCallback({ redirectUri, expectedState: state });

  const resource = discovery.apiResource ?? endpoints.apiBaseUrl.replace(/\/+$/, "");
  const { token, refreshToken } = await requestAuthorizationCodeToken({
    tokenEndpoint: discovery.tokenEndpoint,
    clientId,
    code,
    codeVerifier: verifier,
    redirectUri,
    resource,
  });

  return {
    token,
    refreshToken,
    clientId,
    redirectUri,
    tokenEndpoint: discovery.tokenEndpoint,
  };
}

async function registerPublicClient(options: {
  registrationEndpoint: string;
  clientName: string;
  redirectUris: string[];
  scope: string;
}): Promise<Record<string, unknown>> {
  const body = {
    client_name: options.clientName,
    redirect_uris: options.redirectUris,
    scope: options.scope,
    grant_types: ["authorization_code", "refresh_token"],
    token_endpoint_auth_method: "none",
  };

  const response = await fetch(options.registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (response.status >= 400) {
    throw new AuthenticationError(
      `Client registration failed (${response.status}) at ${options.registrationEndpoint}: ${await response.text()}`,
    );
  }

  const result = (await response.json()) as Record<string, unknown>;
  if (typeof result.client_id !== "string") {
    throw new AuthenticationError(`Invalid registration response: ${JSON.stringify(result)}`);
  }
  return result;
}

function buildAuthorizationUrl(options: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    code_challenge: options.codeChallenge,
    code_challenge_method: "S256",
    state: options.state,
  });
  if (options.scope.trim()) {
    params.set("scope", options.scope.trim());
  }
  return `${options.authorizationEndpoint}?${params.toString()}`;
}

async function requestAuthorizationCodeToken(options: {
  tokenEndpoint: string;
  clientId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  resource: string;
}): Promise<{ token: TokenResponse; refreshToken: string }> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: options.clientId,
    code: options.code,
    code_verifier: options.codeVerifier,
    redirect_uri: options.redirectUri,
    resource: options.resource,
  });

  const response = await fetch(options.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (response.status >= 400) {
    throw new AuthenticationError(
      `Authorization code exchange failed (${response.status}) at ${options.tokenEndpoint}: ${await response.text()}`,
    );
  }

  const body = (await response.json()) as Record<string, unknown>;
  const refreshToken = body.refresh_token;
  if (typeof refreshToken !== "string" || !refreshToken) {
    throw new AuthenticationError(
      `Authorization response missing refresh_token: ${JSON.stringify(body)}`,
    );
  }

  return {
    token: tokenResponseFromBody(body, options.resource),
    refreshToken,
  };
}

/**
 * Exchange a refresh token for a fresh access token plus a rotated refresh token.
 * The returned `refreshToken` replaces the one passed in. Throws
 * {@link FatalAuthError} when the stored refresh token has been server-rejected
 * (most 4xx responses — the credential is dead and must be discarded), or
 * {@link TransientAuthError} for retryable upstream failures (5xx, 408, 429).
 */
export async function requestRefreshTokenExchange(options: {
  tokenEndpoint: string;
  clientId: string;
  refreshToken: string;
  resource: string;
  scope: string;
}): Promise<{ token: TokenResponse; refreshToken: string }> {
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: options.clientId,
    refresh_token: options.refreshToken,
    resource: options.resource,
  });
  if (options.scope.trim()) {
    form.set("scope", options.scope.trim());
  }

  const response = await fetch(options.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (response.status >= 400) {
    const detail = await readOAuthErrorDetail(response);
    const message = `Refresh token exchange failed (${response.status}) at ${options.tokenEndpoint}: ${detail}`;
    if (
      response.status === 408 ||
      response.status === 429 ||
      response.status >= 500
    ) {
      throw new TransientAuthError(message);
    }
    throw new FatalAuthError(message);
  }

  const body = (await response.json()) as Record<string, unknown>;
  const nextRefreshToken = body.refresh_token;
  if (typeof nextRefreshToken !== "string" || !nextRefreshToken) {
    throw new AuthenticationError(
      `Refresh response missing refresh_token: ${JSON.stringify(body)}`,
    );
  }

  return {
    token: tokenResponseFromBody(body, options.resource),
    refreshToken: nextRefreshToken,
  };
}

async function readOAuthErrorDetail(response: Response): Promise<string> {
  const raw = await response.text();
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const error = typeof parsed.error === "string" ? parsed.error : null;
    const description =
      typeof parsed.error_description === "string" ? parsed.error_description : null;
    if (error && description) return `${error}: ${description}`;
    if (description) return description;
    if (error) return error;
  } catch {
    // body was not JSON; fall through to raw text
  }
  return raw;
}

function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(48).toString("base64url");
  const digest = crypto.createHash("sha256").update(verifier, "ascii").digest();
  const challenge = digest.toString("base64url");
  return { verifier, challenge };
}

function waitForOAuthCallback(options: {
  redirectUri: string;
  expectedState: string;
  timeoutSeconds?: number;
}): Promise<string> {
  const { redirectUri, expectedState, timeoutSeconds = 180 } = options;
  const parsed = new URL(redirectUri);
  const callbackPath = parsed.pathname || "/";
  const port = Number(parsed.port);

  if (parsed.protocol !== "http:" || !parsed.hostname || !port) {
    throw new AuthenticationError(
      "PKCE login requires an http loopback redirect URI with an explicit port.",
    );
  }

  return new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host}`);
      if (requestUrl.pathname !== callbackPath) {
        res.writeHead(404);
        res.end();
        return;
      }

      const code = requestUrl.searchParams.get("code") ?? "";
      const state = requestUrl.searchParams.get("state") ?? "";
      const error = requestUrl.searchParams.get("error") ?? "";

      let responseBody: string;
      let statusCode: number;

      if (error) {
        responseBody = `Authorization failed: ${error}`;
        statusCode = 400;
      } else if (!code) {
        responseBody = "Authorization failed: callback did not include a code.";
        statusCode = 400;
      } else if (state !== expectedState) {
        responseBody = "Authorization failed: state mismatch.";
        statusCode = 400;
      } else {
        responseBody =
          "Authorization complete. You can close this window and return to RobotNet CLI.";
        statusCode = 200;
      }

      res.writeHead(statusCode, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Length": String(Buffer.byteLength(responseBody)),
        Connection: "close",
      });
      res.end(responseBody);

      server.close();
      server.closeAllConnections();
      clearTimeout(timer);

      if (statusCode === 200) {
        resolve(code);
      } else {
        reject(new AuthenticationError(responseBody));
      }
    });

    const timer = setTimeout(() => {
      server.close();
      server.closeAllConnections();
      reject(
        new AuthenticationError(
          "Timed out waiting for the browser authorization callback.",
        ),
      );
    }, timeoutSeconds * 1000);

    server.listen(port, parsed.hostname ?? "127.0.0.1");
  });
}
