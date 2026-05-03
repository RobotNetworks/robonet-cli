import { USER_AGENT } from "../version.js";
import { AspApiError, AspNetworkUnreachableError } from "./errors.js";

export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

/**
 * Issue an authenticated JSON request to an ASP endpoint and return the
 * decoded body.
 *
 * - Adds `Authorization: Bearer <token>`, `User-Agent`, and (when a body is
 *   supplied) `Content-Type: application/json`.
 * - Translates connect-time failures to {@link AspNetworkUnreachableError} so
 *   callers can distinguish "couldn't reach the network" from "the network
 *   said no".
 * - Translates non-2xx responses to {@link AspApiError}, preserving the
 *   server's error code when the JSON body has an `error` field.
 * - Returns `null` (typed as `T`) for `204 No Content`.
 *
 * Internal: prefer the wrappers on {@link AspAdminClient} / {@link AspSessionClient}
 * over calling this directly from command modules.
 */
export async function aspRequest<T>(args: {
  readonly baseUrl: string;
  readonly path: string;
  readonly method: HttpMethod;
  readonly token: string;
  readonly body?: unknown;
}): Promise<T> {
  const url = `${args.baseUrl}${args.path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${args.token}`,
    "User-Agent": USER_AGENT,
  };
  if (args.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: args.method,
      headers,
      ...(args.body !== undefined ? { body: JSON.stringify(args.body) } : {}),
    });
  } catch (err) {
    throw new AspNetworkUnreachableError(
      args.baseUrl,
      err instanceof Error ? err : undefined,
    );
  }

  if (res.status === 204) {
    return null as T;
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    json = undefined;
  }

  if (!res.ok) {
    const code = isErrorBody(json) ? json.error : `http_${res.status}`;
    throw new AspApiError(res.status, code);
  }

  return json as T;
}

function isErrorBody(v: unknown): v is { error: string } {
  return (
    typeof v === "object" &&
    v !== null &&
    "error" in v &&
    typeof (v as { error: unknown }).error === "string"
  );
}
