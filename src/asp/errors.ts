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

  constructor(status: number, code: string, message?: string) {
    super(message ?? `ASP API error ${status}: ${code}`);
    this.name = "AspApiError";
    this.status = status;
    this.code = code;
  }
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
