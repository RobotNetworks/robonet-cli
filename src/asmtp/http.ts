import { randomUUID } from "node:crypto";
import { USER_AGENT } from "../version.js";
import { AsmtpApiError, AsmtpNetworkUnreachableError } from "./errors.js";

export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

/** Methods on which the operator may require an `Idempotency-Key` header. */
const UNSAFE_METHODS: ReadonlySet<HttpMethod> = new Set(["POST", "PATCH", "DELETE"]);

/**
 * Issue an authenticated JSON request and return the decoded body.
 *
 * - Adds `Authorization: Bearer <token>`, `User-Agent`, and (when a body is
 *   supplied) `Content-Type: application/json`.
 * - Translates connect-time failures to {@link AsmtpNetworkUnreachableError}
 *   so callers can distinguish "couldn't reach the network" from "the network
 *   said no".
 * - Translates non-2xx responses to {@link AsmtpApiError}, preserving the
 *   server's error code when the JSON body has a structured `error` field.
 * - Returns `null` (typed as `T`) for `204 No Content`.
 */
export async function asmtpRequest<T>(args: {
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
    throw new AsmtpNetworkUnreachableError(
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
    throw new AsmtpApiError(res.status, code, detail !== undefined ? { detail } : undefined);
  }

  return json as T;
}

/**
 * Three error envelopes appear in the wild:
 *   1. `{"error": "<code>"}` legacy shape.
 *   2. `{"error": {"code": "...", "message": "...", "docs_url": "..."}}`
 *      structured envelope. `message` becomes the user-facing detail and
 *      `code` is the stable identifier.
 *   3. `{"detail": ...}` FastAPI-style. `detail` surfaces directly.
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
 * Variant of {@link asmtpRequest} for endpoints that respond with a non-JSON
 * body (e.g. `text/markdown`). Same auth/error semantics — returns the body
 * as a string on 2xx and translates non-2xx into {@link AsmtpApiError} via
 * the same code-extraction path.
 */
export async function asmtpTextRequest(args: {
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
    throw new AsmtpNetworkUnreachableError(
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
    throw new AsmtpApiError(res.status, code, detail !== undefined ? { detail } : undefined);
  }

  return await res.text();
}
