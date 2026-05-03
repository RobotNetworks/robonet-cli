import type { IncomingMessage, ServerResponse } from "node:http";

import { MethodNotAllowedError, NotFoundError } from "../errors.js";

/**
 * Tiny pattern-matching router for the operator's HTTP surface.
 *
 * Patterns use `:name` for path parameters; resolved values are passed in
 * the {@link RouteContext}. Path parameters are URI-decoded so handlers
 * receive the original characters (e.g. `:handle` for `@example.bot` is
 * delivered as `@example.bot`, not `%40example.bot`).
 *
 * Routes are matched in registration order; the first match wins. A path
 * that matches no route at all yields {@link NotFoundError}; a path that
 * matches but with the wrong HTTP method yields {@link MethodNotAllowedError}.
 */

export interface RouteContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly params: Readonly<Record<string, string>>;
}

export type RouteHandler = (ctx: RouteContext) => void | Promise<void>;

interface Route {
  readonly method: string;
  readonly pattern: string;
  readonly regex: RegExp;
  readonly paramNames: readonly string[];
  readonly handler: RouteHandler;
}

export class Router {
  readonly #routes: Route[] = [];

  add(method: string, pattern: string, handler: RouteHandler): void {
    const { regex, paramNames } = compilePattern(pattern);
    this.#routes.push({
      method: method.toUpperCase(),
      pattern,
      regex,
      paramNames,
      handler,
    });
  }

  /** Resolve a request to a handler. Throws {@link NotFoundError} or {@link MethodNotAllowedError}. */
  resolve(method: string, pathname: string): {
    readonly handler: RouteHandler;
    readonly params: Readonly<Record<string, string>>;
  } {
    let methodMismatch = false;
    for (const r of this.#routes) {
      const match = r.regex.exec(pathname);
      if (match === null) continue;
      if (r.method !== method.toUpperCase()) {
        methodMismatch = true;
        continue;
      }
      const params: Record<string, string> = {};
      r.paramNames.forEach((name, i) => {
        // i+1 because match[0] is the full match.
        params[name] = decodeURIComponent(match[i + 1]);
      });
      return { handler: r.handler, params };
    }
    if (methodMismatch) {
      throw new MethodNotAllowedError(method, pathname);
    }
    throw new NotFoundError(`no route matches ${method} ${pathname}`);
  }
}

function compilePattern(pattern: string): {
  readonly regex: RegExp;
  readonly paramNames: readonly string[];
} {
  const paramNames: string[] = [];
  // Preserve `/` between segments; for each segment, replace `:name`
  // with a capturing group that matches up to the next `/`.
  const escaped = pattern
    .split("/")
    .map((segment) => {
      if (segment.startsWith(":")) {
        paramNames.push(segment.slice(1));
        return "([^/]+)";
      }
      // Escape regex metacharacters in literal segments.
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { regex: new RegExp(`^${escaped}$`), paramNames };
}
