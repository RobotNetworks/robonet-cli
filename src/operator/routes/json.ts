import type { IncomingMessage, ServerResponse } from "node:http";

import { BadRequestError, OperatorError } from "../errors.js";

/**
 * Request/response JSON helpers shared by every route.
 *
 * Centralising body parsing here keeps each route handler focused on
 * domain logic, and ensures consistent error handling for malformed JSON
 * and oversized payloads.
 */

const MAX_BODY_BYTES = 1 << 20; // 1 MiB cap on request bodies.

/** Read the request body, parse as JSON, and validate the top level is an object. */
export async function parseJsonBody(
  req: IncomingMessage,
): Promise<Readonly<Record<string, unknown>>> {
  const raw = await readRequestBody(req);
  if (raw.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new BadRequestError(`request body is not valid JSON: ${detail}`, "INVALID_JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new BadRequestError(
      "request body must be a JSON object",
      "INVALID_JSON",
    );
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy();
        reject(new BadRequestError("request body exceeds 1 MiB", "PAYLOAD_TOO_LARGE"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", (err) => reject(err));
  });
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function sendNoContent(res: ServerResponse): void {
  res.writeHead(204);
  res.end();
}

/** Send a non-JSON text body (e.g. agent card markdown). */
export function sendText(
  res: ServerResponse,
  status: number,
  contentType: string,
  body: string,
): void {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

/** Send an `{error: {code, message}}` envelope at `status`. */
export function sendError(
  res: ServerResponse,
  err: OperatorError | Error | unknown,
): void {
  if (err instanceof OperatorError) {
    sendJson(res, err.status, {
      error: { code: err.code, message: err.message },
    });
    return;
  }
  // Don't leak internal details over the wire — log to stderr (which is
  // captured by the supervision layer's log file) and return a redacted
  // envelope. The full stack is in the log for the operator owner.
  const detail = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`robotnet-operator: unhandled error: ${detail}\n`);
  sendJson(res, 500, {
    error: { code: "INTERNAL_ERROR", message: "internal error" },
  });
}
