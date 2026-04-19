import { REQUEST_TIMEOUT_MS } from "../endpoints.js";
import { AuthenticationError } from "../errors.js";

/** Default OAuth scope set requested by the CLI; grants read/write on agents, threads, contacts, and realtime. */
export const DEFAULT_SCOPES =
  "agents:read threads:read threads:write contacts:read contacts:write realtime:read";

/** Normalized OAuth token response. `expiresIn` is in seconds (per RFC 6749), not milliseconds. */
export interface TokenResponse {
  readonly accessToken: string;
  readonly tokenType: string;
  readonly expiresIn: number | null;
  readonly scope: string | null;
  readonly resource: string;
}

/** Parse an OAuth token endpoint JSON body into a {@link TokenResponse}. Throws {@link AuthenticationError} if `access_token` is missing. */
export function tokenResponseFromBody(
  body: Record<string, unknown>,
  resource: string,
): TokenResponse {
  const accessToken = body.access_token;
  if (typeof accessToken !== "string" || !accessToken) {
    throw new AuthenticationError(`Invalid token response: ${JSON.stringify(body)}`);
  }
  const tokenType =
    typeof body.token_type === "string" && body.token_type ? body.token_type : "Bearer";
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : null;
  const scope = typeof body.scope === "string" ? body.scope : null;

  return { accessToken, tokenType, expiresIn, scope, resource };
}

/** Exchange client credentials for an access token bound to `resource`. Throws {@link AuthenticationError} on HTTP or network failure. */
export async function requestClientCredentialsToken(options: {
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  resource: string;
  scope?: string;
}): Promise<TokenResponse> {
  const { tokenEndpoint, clientId, clientSecret, resource, scope = DEFAULT_SCOPES } = options;

  const form = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    resource,
  });
  if (scope.trim()) {
    form.set("scope", scope.trim());
  }

  let response: Response;
  try {
    response = await fetch(tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new AuthenticationError(`Token request failed: ${err}`);
  }

  if (response.status >= 400) {
    let detail: unknown = await response.text();
    try {
      detail = JSON.parse(detail as string);
    } catch {
      // keep as text
    }
    throw new AuthenticationError(
      `Token request failed (${response.status}) at ${tokenEndpoint}: ${JSON.stringify(detail)}`,
    );
  }

  const body = (await response.json()) as Record<string, unknown>;
  return tokenResponseFromBody(body, resource);
}
