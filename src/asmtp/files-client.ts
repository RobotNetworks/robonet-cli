/**
 * Typed client for the operator-hosted file surface.
 *
 * `POST /files` accepts the bytes and returns upload metadata keyed by
 * an opaque `id`. The sender embeds `{type:"file"|"image", file_id}`
 * on the outbound envelope; the operator resolves `file_id` to a
 * signed URL at envelope-accept time. There is no `url` in the upload
 * response — see `PostFileResponse` in `./types.ts`.
 *
 * `GET /files/{id}` resolves an id to a fresh signed URL; operators
 * may either 302 to the signed URL or stream bytes inline. This
 * client follows 302 redirects and returns whichever bytes land.
 */

import { randomUUID } from "node:crypto";

import { USER_AGENT } from "../version.js";
import { AsmtpApiError, AsmtpNetworkUnreachableError } from "./errors.js";
import type { PostFileResponse } from "./types.js";

export interface UploadInput {
  /** Raw bytes to upload. */
  readonly bytes: Uint8Array;
  /** Filename to send in the multipart Content-Disposition header. */
  readonly filename: string;
  /** Declared content type. Operators may validate against an allowlist
   *  and reject content-type / magic-byte mismatches. */
  readonly contentType: string;
}

export interface DownloadResult {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  /** Filename advertised by the server's Content-Disposition, when set. */
  readonly filename: string | null;
}

const FILE_ID_RE = /^file_[0-9A-Za-z_-]+$/;

export class FilesClient {
  readonly #baseUrl: string;
  readonly #token: string;

  constructor(baseUrl: string, token: string) {
    this.#baseUrl = baseUrl;
    this.#token = token;
  }

  /**
   * Upload a binary to the operator's `POST /files`. Returns the
   * upload metadata (see {@link PostFileResponse}); the sender uses
   * `result.id` as the `file_id` on the envelope's `file`/`image`
   * content parts.
   */
  async upload(input: UploadInput): Promise<PostFileResponse> {
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
      throw new AsmtpNetworkUnreachableError(
        this.#baseUrl,
        err instanceof Error ? err : undefined,
      );
    }
    if (!res.ok) {
      throw await readApiError(res);
    }
    return (await res.json()) as PostFileResponse;
  }

  /**
   * Download a file by id (resolved against ``baseUrl``) or by an absolute
   * URL (e.g. a signed URL emitted in a `file` content part). When the
   * input is a bare ``file_…`` id, the request is bearer-authenticated
   * against the operator; signed absolute URLs go through unauthenticated
   * since the URL itself carries the credential.
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
      throw new AsmtpNetworkUnreachableError(
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

async function readApiError(res: Response): Promise<AsmtpApiError> {
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
  return new AsmtpApiError(res.status, code, detail !== undefined ? { detail } : undefined);
}
