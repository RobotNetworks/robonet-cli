import { randomUUID } from "node:crypto";
import { USER_AGENT } from "../version.js";
import { AspApiError, AspNetworkUnreachableError } from "./errors.js";

export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

/** Methods for which the operator may require an `Idempotency-Key` header. */
const UNSAFE_METHODS: ReadonlySet<HttpMethod> = new Set(["POST", "PATCH", "DELETE"]);

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
  // The hosted operator requires `Idempotency-Key` on every unsafe verb.
  // Body-level `idempotency_key` (when supplied) still takes precedence at
  // the server; this header just keeps the request from being rejected
  // before the body validator runs.
  if (UNSAFE_METHODS.has(args.method)) {
    headers["Idempotency-Key"] = randomUUID();
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

  let bodyText = "";
  try {
    bodyText = await res.text();
  } catch {
    bodyText = "";
  }
  let json: unknown;
  try {
    json = bodyText.length > 0 ? JSON.parse(bodyText) : undefined;
  } catch {
    json = undefined;
  }

  if (!res.ok) {
    const parsed = parseErrorBody(json);
    const code = parsed.code ?? `http_${res.status}`;
    const detail =
      parsed.detail ?? (bodyText.length > 0 ? bodyText.slice(0, 500) : undefined);
    throw new AspApiError(res.status, code, detail !== undefined ? { detail } : undefined);
  }

  return json as T;
}

/**
 * Three error envelopes appear in the wild:
 *   1. `{"error": "<code>"}` — legacy shape from older operators.
 *   2. `{"error": {"code": "...", "message": "...", "docs_url": "..."}}` —
 *      the hosted operator's structured envelope. Surface `message` as
 *      the user-facing detail and `code` as the stable identifier.
 *   3. `{"detail": ...}` — FastAPI's default validation shape (string
 *      or list of `{loc, msg}` items). Surface `detail` directly.
 */
function parseErrorBody(v: unknown): { code: string | undefined; detail: unknown } {
  if (typeof v !== "object" || v === null) {
    return { code: undefined, detail: undefined };
  }
  const obj = v as Record<string, unknown>;
  const error = obj["error"];
  if (typeof error === "string") {
    return { code: error, detail: obj["detail"] };
  }
  if (typeof error === "object" && error !== null) {
    const e = error as Record<string, unknown>;
    const code = typeof e["code"] === "string" ? (e["code"] as string) : undefined;
    const message = typeof e["message"] === "string" ? (e["message"] as string) : undefined;
    return { code, detail: message ?? obj["detail"] };
  }
  return { code: undefined, detail: obj["detail"] };
}

/**
 * Variant of {@link aspRequest} for endpoints that respond with a non-JSON
 * body (e.g. `text/markdown`). Same auth/error semantics as `aspRequest` —
 * just returns the body as a string on 2xx and translates non-2xx into
 * {@link AspApiError} via the same code-extraction path.
 */
export async function aspTextRequest(args: {
  readonly baseUrl: string;
  readonly path: string;
  readonly token: string;
}): Promise<string> {
  const url = `${args.baseUrl}${args.path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${args.token}`,
    "User-Agent": USER_AGENT,
    Accept: "text/markdown, text/plain, */*",
  };

  let res: Response;
  try {
    res = await fetch(url, { method: "GET", headers });
  } catch (err) {
    throw new AspNetworkUnreachableError(
      args.baseUrl,
      err instanceof Error ? err : undefined,
    );
  }

  if (!res.ok) {
    let bodyText = "";
    try {
      bodyText = await res.text();
    } catch {
      bodyText = "";
    }
    let json: unknown;
    try {
      json = bodyText.length > 0 ? JSON.parse(bodyText) : undefined;
    } catch {
      json = undefined;
    }
    const parsed = parseErrorBody(json);
    const code = parsed.code ?? `http_${res.status}`;
    const detail =
      parsed.detail ?? (bodyText.length > 0 ? bodyText.slice(0, 500) : undefined);
    throw new AspApiError(res.status, code, detail !== undefined ? { detail } : undefined);
  }

  return await res.text();
}
