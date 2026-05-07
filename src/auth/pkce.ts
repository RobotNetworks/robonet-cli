import * as crypto from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

import type { TokenResponse } from "./client-credentials.js";
import {
  tokenResponseFromBody,
  DEFAULT_AGENT_SCOPES,
  DEFAULT_USER_SCOPES,
} from "./client-credentials.js";
import type { OAuthDiscovery } from "./discovery.js";
import type { NetworkConfig } from "../config.js";
import { REQUEST_TIMEOUT_MS } from "../endpoints.js";
import {
  AuthenticationError,
  FatalAuthError,
  TransientAuthError,
} from "../errors.js";

const DEFAULT_PUBLIC_CLIENT_NAME = "robotnet-cli";
const CALLBACK_PATH = "/callback";

/** Result of a successful PKCE login: the API access token plus the long-lived
 *  data needed to refresh it.
 *
 *  ``agentHandle`` is populated for agent-scoped flows (echoed by the auth
 *  server's RFC-6749-compliant token-endpoint extension) and ``null`` for
 *  user-scoped flows. The wire form is canonical (``owner.agent``, no
 *  leading ``@``); callers prepend the prefix to match the rest of the CLI
 *  surface.
 *
 *  ``network`` is the auth server's self-declared network slug. The CLI
 *  uses it to verify it actually reached the network it dialed (defense
 *  in depth against a profile that wires OAuth endpoints from one network
 *  but stores credentials under another). ``null`` when the auth server
 *  hasn't been configured with a network slug — older deployments. */
export interface PKCELoginResult {
  readonly token: TokenResponse;
  readonly refreshToken: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly tokenEndpoint: string;
  readonly agentHandle: string | null;
  readonly network: string | null;
}

/**
 * Where the agent PKCE flow points the browser.
 *
 * - ``handle``  — CLI specified an explicit agent (`robotnet login --agent @x.y`).
 *                 The web shows a one-button "Authorize @x.y" confirmation.
 * - ``picker``  — CLI asked us to pick (`robotnet login --agent` no value).
 *                 The web shows the agent picker; the chosen handle comes
 *                 back via ``PKCELoginResult.agentHandle``.
 */
export type AgentLoginTarget =
  | { kind: "handle"; handle: string }
  | { kind: "picker" };

/** Common options accepted by both user and agent PKCE flows. */
interface CorePkceOptions {
  readonly network: NetworkConfig;
  readonly discovery: OAuthDiscovery;
  readonly scope?: string;
  readonly clientName?: string;
  /**
   * Extra query parameters to append to the authorization URL. Used by the
   * agent flow to pass `agent_handle=@x.y` so the auth server scopes the
   * issued token to that agent rather than the calling user.
   */
  readonly extraAuthParams?: Readonly<Record<string, string>>;
  /**
   * Human-facing label printed when opening the browser. Distinguishes
   * "RobotNet login" from "RobotNet agent login (@x.y)" without leaking
   * implementation details into the URL.
   */
  readonly browserPrompt?: string;
}

/**
 * Drive a full OAuth 2.0 PKCE browser login for the calling user (no agent
 * binding). Defaults to the user-bucket scope set; pass ``options.scope``
 * to override.
 *
 * Implementation: dynamic client registration, ephemeral loopback callback
 * (random port, matching the auth server's `^http://127\.0\.0\.1:\d+/callback$`
 * pattern validator), authorization URL, and code exchange. Throws
 * {@link AuthenticationError} on user cancel, state mismatch, or network
 * failure.
 */
export async function performPkceLogin(
  options: CorePkceOptions,
): Promise<PKCELoginResult> {
  return await runPkceFlow({ ...options, scope: options.scope ?? DEFAULT_USER_SCOPES });
}

/**
 * Drive an agent-scoped PKCE login. Same loopback-callback flow as
 * {@link performPkceLogin}, but the authorization URL signals one of two
 * things to the web consent page:
 *
 *   - ``target.kind === "handle"``: includes ``agent_handle=<handle>`` so
 *     the consent page renders a single-button confirmation.
 *   - ``target.kind === "picker"``: includes ``intent=select_agent`` so
 *     the consent page renders the agent picker. The user's choice comes
 *     back as ``agent_handle`` on the token-endpoint response, and is
 *     surfaced on ``PKCELoginResult.agentHandle``.
 *
 * The user must be signed in to auth.robotnet.ai in their browser. If they
 * aren't, the consent page handles the human login first and then proceeds
 * with the agent authorization.
 */
export async function performAgentPkceLogin(args: {
  readonly network: NetworkConfig;
  readonly discovery: OAuthDiscovery;
  readonly target: AgentLoginTarget;
  readonly scope?: string;
  readonly clientName?: string;
}): Promise<PKCELoginResult> {
  const extraParams: Record<string, string> =
    args.target.kind === "handle"
      ? { agent_handle: args.target.handle }
      : { intent: "select_agent" };
  const prompt =
    args.target.kind === "handle"
      ? `Opening browser for RobotNet agent authorization (${args.target.handle}).`
      : "Opening browser to pick an agent for RobotNet.";
  return await runPkceFlow({
    network: args.network,
    discovery: args.discovery,
    scope: args.scope ?? DEFAULT_AGENT_SCOPES,
    ...(args.clientName !== undefined ? { clientName: args.clientName } : {}),
    extraAuthParams: extraParams,
    browserPrompt: prompt,
  });
}

/* -------------------------------------------------------------------------- */
/* Core flow                                                                   */
/* -------------------------------------------------------------------------- */

async function runPkceFlow(options: CorePkceOptions): Promise<PKCELoginResult> {
  const {
    network,
    discovery,
    // Each public entrypoint (`performPkceLogin`, `performAgentPkceLogin`)
    // sets its own scope default; we never silently fall back here so a
    // missing scope is loud rather than mis-bucketed.
    scope = DEFAULT_USER_SCOPES,
    clientName = DEFAULT_PUBLIC_CLIENT_NAME,
    extraAuthParams = {},
    browserPrompt = "Opening browser for RobotNet login.",
  } = options;

  // Two-step dance with the loopback server: bind first to learn the
  // ephemeral port, build the redirect_uri from it, register the public
  // client with that exact URI, then start awaiting the callback. The
  // server's validator only accepts `http://127.0.0.1:<port>/callback`,
  // so the redirect_uri must be known *before* we hit /authorize.
  const loopback = await reserveLoopback();
  const redirectUri = `http://127.0.0.1:${loopback.port}${CALLBACK_PATH}`;

  let result: PKCELoginResult;
  try {
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
      extraParams: extraAuthParams,
    });

    console.log(browserPrompt);
    console.log(authorizationUrl);
    const open = (await import("open")).default;
    await open(authorizationUrl);

    const code = await loopback.awaitCode(state);

    const resource = discovery.apiResource ?? network.url.replace(/\/+$/, "");
    const tokenResult = await requestAuthorizationCodeToken({
      tokenEndpoint: discovery.tokenEndpoint,
      clientId,
      code,
      codeVerifier: verifier,
      redirectUri,
      resource,
    });

    result = {
      token: tokenResult.token,
      refreshToken: tokenResult.refreshToken,
      clientId,
      redirectUri,
      tokenEndpoint: discovery.tokenEndpoint,
      agentHandle: tokenResult.agentHandle,
      network: tokenResult.network,
    };
  } finally {
    loopback.close();
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* Loopback callback server                                                    */
/* -------------------------------------------------------------------------- */

interface LoopbackHandle {
  readonly port: number;
  awaitCode(expectedState: string, timeoutMs?: number): Promise<string>;
  close(): void;
}

/**
 * Bind an HTTP server on `127.0.0.1:0` (ephemeral port) and return a
 * handle that can be polled for the OAuth callback. Splitting the bind
 * from the callback wait means the redirect_uri is known before we
 * register the public client.
 */
async function reserveLoopback(): Promise<LoopbackHandle> {
  const server = http.createServer();

  await new Promise<void>((resolve, reject) => {
    const onErr = (err: Error): void => {
      server.removeListener("listening", onListen);
      reject(err);
    };
    const onListen = (): void => {
      server.removeListener("error", onErr);
      resolve();
    };
    server.once("error", onErr);
    server.once("listening", onListen);
    server.listen(0, "127.0.0.1");
  });

  const addr = server.address() as AddressInfo;
  const port = addr.port;

  let onRequest: ((req: http.IncomingMessage, res: http.ServerResponse) => void) | null = null;
  server.on("request", (req, res) => {
    onRequest?.(req, res);
  });

  return {
    port,
    awaitCode: (expectedState: string, timeoutMs: number = 180_000) =>
      new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          onRequest = null;
          reject(
            new AuthenticationError(
              "Timed out waiting for the browser authorization callback.",
            ),
          );
        }, timeoutMs);

        onRequest = (req, res) => {
          const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
          if (requestUrl.pathname !== CALLBACK_PATH) {
            res.writeHead(404);
            res.end();
            return;
          }
          const code = requestUrl.searchParams.get("code") ?? "";
          const state = requestUrl.searchParams.get("state") ?? "";
          const error = requestUrl.searchParams.get("error") ?? "";

          let body: string;
          let status: number;
          if (error) {
            body = `Authorization failed: ${error}`;
            status = 400;
          } else if (!code) {
            body = "Authorization failed: callback did not include a code.";
            status = 400;
          } else if (state !== expectedState) {
            body = "Authorization failed: state mismatch.";
            status = 400;
          } else {
            body = "Authorization complete. You can close this window and return to RobotNet CLI.";
            status = 200;
          }

          res.writeHead(status, {
            "Content-Type": "text/plain; charset=utf-8",
            "Content-Length": String(Buffer.byteLength(body)),
            Connection: "close",
          });
          res.end(body);
          clearTimeout(timer);
          onRequest = null;

          if (status === 200) {
            resolve(code);
          } else {
            reject(new AuthenticationError(body));
          }
        };
      }),
    close: () => {
      onRequest = null;
      server.close();
      server.closeAllConnections();
    },
  };
}

/* -------------------------------------------------------------------------- */
/* OAuth wire calls                                                            */
/* -------------------------------------------------------------------------- */

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
  extraParams: Readonly<Record<string, string>>;
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
  for (const [k, v] of Object.entries(options.extraParams)) {
    params.set(k, v);
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
}): Promise<{
  token: TokenResponse;
  refreshToken: string;
  agentHandle: string | null;
  network: string | null;
}> {
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

  // RobotNet auth-server extension (RFC 6749 §5.1 permits): agent-scoped
  // tokens carry the canonical handle so the CLI can key its credential
  // row without decoding the JWT. Absent on user-scoped responses. Wire
  // form is canonical (``owner.agent``); the CLI prepends ``@`` when it
  // stores the handle so it matches every other agent row.
  const rawAgentHandle = body.agent_handle;
  const agentHandle =
    typeof rawAgentHandle === "string" && rawAgentHandle.length > 0
      ? rawAgentHandle
      : null;

  // Operator's self-declared network slug — defense in depth for the
  // CLI to confirm it talked to the network it dialed. May be absent on
  // older deployments that haven't set OAUTH_NETWORK_NAME; the caller
  // falls back to local config in that case.
  const rawNetwork = body.network;
  const network =
    typeof rawNetwork === "string" && rawNetwork.length > 0 ? rawNetwork : null;

  return {
    token: tokenResponseFromBody(body, options.resource),
    refreshToken,
    agentHandle,
    network,
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
