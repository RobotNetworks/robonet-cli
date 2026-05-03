import type { CLIConfig } from "../config.js";
import { REQUEST_TIMEOUT_MS } from "../endpoints.js";
import { AuthenticationError } from "../errors.js";

/**
 * Fetch the agents owned by the human user behind `accessToken`.
 *
 * The auth-server owns this list — it has the `oauth_clients` table and the
 * `account_id` linkage we need. Endpoint shape (per migration.bot):
 *   GET <api>/accounts/me/agents
 *   Authorization: Bearer <user_access_token>
 *   200 → { agents: [{handle, name?, policy?}, ...] }
 *
 * The CLI uses this exclusively as input to the no-handle agent picker
 * (`robotnet login --agent`). Tolerant of extra fields the server might
 * add later — only `handle` is required, anything else is opportunistic.
 */
export interface AccountAgent {
  readonly handle: string;
  readonly name?: string;
  readonly policy?: string;
}

export async function fetchAccountAgents(args: {
  readonly config: CLIConfig;
  readonly accessToken: string;
}): Promise<readonly AccountAgent[]> {
  const url = `${args.config.endpoints.apiBaseUrl.replace(/\/+$/, "")}/accounts/me/agents`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${args.accessToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new AuthenticationError(
      `Failed to list account agents at ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new AuthenticationError(
      `User session is not authorized to list agents at ${url} (status ${response.status}). ` +
        `Run \`robotnet login\` to refresh your session.`,
    );
  }
  if (response.status >= 400) {
    throw new AuthenticationError(
      `Failed to list account agents (${response.status}) at ${url}: ${await response.text()}`,
    );
  }

  const body = (await response.json()) as unknown;
  return parseAgentsBody(body, url);
}

function parseAgentsBody(body: unknown, url: string): readonly AccountAgent[] {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new AuthenticationError(
      `Unexpected response shape from ${url}: not a JSON object`,
    );
  }
  const raw = (body as Record<string, unknown>).agents;
  if (!Array.isArray(raw)) {
    throw new AuthenticationError(
      `Unexpected response shape from ${url}: missing "agents" array`,
    );
  }
  const out: AccountAgent[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new AuthenticationError(
        `Unexpected response from ${url}: agents[${i}] is not an object`,
      );
    }
    const o = entry as Record<string, unknown>;
    if (typeof o.handle !== "string" || o.handle.length === 0) {
      throw new AuthenticationError(
        `Unexpected response from ${url}: agents[${i}].handle is missing or not a string`,
      );
    }
    const agent: AccountAgent = {
      handle: o.handle,
      ...(typeof o.name === "string" && o.name.length > 0 ? { name: o.name } : {}),
      ...(typeof o.policy === "string" && o.policy.length > 0 ? { policy: o.policy } : {}),
    };
    out.push(agent);
  }
  return out;
}
