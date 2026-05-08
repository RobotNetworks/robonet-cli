import { RobotNetCLIError } from "../errors.js";

/**
 * Thrown when an ASP HTTP request returns a non-2xx response.
 *
 * `code` is the `error` field from the JSON body when present; otherwise
 * the synthetic string `http_<status>` so callers always see a stable
 * identifier they can match on.
 */
export class AspApiError extends RobotNetCLIError {
  readonly status: number;
  readonly code: string;
  readonly detail?: unknown;

  constructor(status: number, code: string, opts?: { message?: string; detail?: unknown }) {
    const detailHint = formatDetail(opts?.detail);
    super(opts?.message ?? `ASP API error ${status}: ${code}${detailHint}`);
    this.name = "AspApiError";
    this.status = status;
    this.code = code;
    this.detail = opts?.detail;
  }
}

/**
 * Render the server's error body as a one-line hint when it carries
 * actionable detail. We surface FastAPI's validation shape
 * (`{"detail": [{...}]}`) and any plain `{"detail": "..."}` text.
 * Returns "" when the body has nothing the user can act on.
 */
function formatDetail(detail: unknown): string {
  if (detail === undefined || detail === null) return "";
  if (typeof detail === "string") return ` — ${detail}`;
  if (Array.isArray(detail)) {
    const lines = detail
      .map((item) => {
        if (typeof item === "string") return item;
        if (typeof item !== "object" || item === null) return null;
        const o = item as Record<string, unknown>;
        const loc = Array.isArray(o["loc"]) ? o["loc"].join(".") : undefined;
        const msg = typeof o["msg"] === "string" ? o["msg"] : undefined;
        if (loc !== undefined && msg !== undefined) return `${loc}: ${msg}`;
        return msg ?? null;
      })
      .filter((s): s is string => typeof s === "string");
    return lines.length > 0 ? ` — ${lines.join("; ")}` : "";
  }
  return "";
}

/**
 * Thrown when the ASP network is unreachable — TCP connection refused, DNS
 * failure, or the local supervisor has not started a network at the given URL.
 *
 * Distinct from {@link AspApiError}: the request never completed, so retrying
 * or pointing at a different network is the right user action, not authn.
 */
export class AspNetworkUnreachableError extends RobotNetCLIError {
  readonly url: string;
  readonly cause?: Error;

  constructor(url: string, cause?: Error) {
    const detail = cause ? `: ${cause.message}` : "";
    super(`could not reach ASP network at ${url}${detail}`);
    this.name = "AspNetworkUnreachableError";
    this.url = url;
    this.cause = cause;
  }
}
