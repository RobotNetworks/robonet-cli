/**
 * Typed client for the operator's file surface (`POST /files`,
 * `GET /files/:id`).
 *
 * Same auth model as `AspSessionClient`: every call carries the
 * agent's bearer token. The download path also accepts the operator's
 * own URL form (`http(s)://.../files/<id>`) so signed CloudFront URLs
 * delivered in `session.message` payloads work without extra plumbing.
 */

import { randomUUID } from "node:crypto";

import { USER_AGENT } from "../version.js";
import { AspApiError, AspNetworkUnreachableError } from "./errors.js";

export interface FileUploadResponse {
  readonly id: string;
  readonly status: "pending" | "attached";
  readonly filename: string;
  readonly content_type: string;
  readonly size_bytes: number;
  readonly created_at: number;
  readonly expires_at: number | null;
}

export interface UploadInput {
  /** Raw bytes to upload. */
  readonly bytes: Uint8Array;
  /** Filename to send in the multipart Content-Disposition header. */
  readonly filename: string;
  /** Declared content type. The operator validates against an allowlist
   *  and rejects content-type / magic-byte mismatches. */
  readonly contentType: string;
}

export interface DownloadResult {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  /** Filename advertised by the server's Content-Disposition, when set. */
  readonly filename: string | null;
}

const FILE_ID_RE = /^file_[0-9A-Za-z_-]+$/;

export class AspFilesClient {
  readonly #baseUrl: string;
  readonly #token: string;

  constructor(baseUrl: string, token: string) {
    this.#baseUrl = baseUrl;
    this.#token = token;
  }

  /** Upload a binary to the operator's `POST /files`. Returns the
   *  pending file metadata; the bytes are claimed by referencing
   *  ``id`` from a session message's ``{type:"file", file_id:"…"}``
   *  part. */
  async upload(input: UploadInput): Promise<FileUploadResponse> {
    const form = new FormData();
    form.append(
      "file",
      new Blob([input.bytes], { type: input.contentType }),
      input.filename,
    );
    const url = `${this.#baseUrl}/files`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#token}`,
      "User-Agent": USER_AGENT,
      "Idempotency-Key": randomUUID(),
    };
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers, body: form });
    } catch (err) {
      throw new AspNetworkUnreachableError(
        this.#baseUrl,
        err instanceof Error ? err : undefined,
      );
    }
    if (!res.ok) {
      throw await readApiError(res);
    }
    return (await res.json()) as FileUploadResponse;
  }

  /** Download a file by id (resolves against ``baseUrl``) or by an
   *  absolute URL (e.g. a signed CloudFront URL emitted in a
   *  ``session.message`` event). When the input is a bare ``file_…``
   *  id, the request is bearer-authenticated against the operator;
   *  signed absolute URLs go through unauthenticated since the URL
   *  itself carries the credential.
   */
  async download(idOrUrl: string): Promise<DownloadResult> {
    const isFileId = FILE_ID_RE.test(idOrUrl);
    const url = isFileId
      ? `${this.#baseUrl}/files/${encodeURIComponent(idOrUrl)}`
      : idOrUrl;
    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
    };
    if (isFileId || url.startsWith(this.#baseUrl)) {
      headers.Authorization = `Bearer ${this.#token}`;
    }

    let res: Response;
    try {
      res = await fetch(url, { method: "GET", headers });
    } catch (err) {
      throw new AspNetworkUnreachableError(
        this.#baseUrl,
        err instanceof Error ? err : undefined,
      );
    }
    if (!res.ok) {
      throw await readApiError(res);
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    const contentType = res.headers.get("content-type") ?? "application/octet-stream";
    const disposition = res.headers.get("content-disposition") ?? "";
    const match = disposition.match(/filename="?([^"]+)"?/);
    const filename = match !== null ? (match[1] ?? null) : null;
    return { bytes: buf, contentType, filename };
  }
}

async function readApiError(res: Response): Promise<AspApiError> {
  let text = "";
  try {
    text = await res.text();
  } catch {
    text = "";
  }
  let code = `http_${res.status}`;
  let detail: unknown = text.length > 0 ? text.slice(0, 500) : undefined;
  try {
    if (text.length > 0) {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const error = parsed["error"];
      if (typeof error === "string") {
        code = error;
      } else if (typeof error === "object" && error !== null) {
        const e = error as Record<string, unknown>;
        if (typeof e["code"] === "string") code = e["code"];
        if (typeof e["message"] === "string") detail = e["message"];
      } else if (typeof parsed["detail"] === "string") {
        detail = parsed["detail"];
      }
    }
  } catch {
    // Body wasn't JSON — keep the raw-text detail.
  }
  return new AspApiError(res.status, code, detail !== undefined ? { detail } : undefined);
}
