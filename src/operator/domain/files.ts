/**
 * In-tree operator file service (dev-only reference implementation).
 *
 * Bytes live in the per-network filesDir (sibling to `operator.sqlite`);
 * the upload returns an opaque `file_…` id. The sender embeds
 * `{type:"file"|"image", file_id}` on a content part; the operator
 * resolves `file_id` to its own `GET /files/{id}` URL at envelope-
 * accept time so the stored envelope carries `url` (wire-canonical
 * for the bake-at-accept operator strategy).
 *
 * Note: this is one of two valid operator strategies the wire spec
 * permits. The production Robot Networks operator instead keeps
 * `file_id` on the stored envelope and mints a fresh signed URL on
 * every read — so attachments don't expire with their previous
 * signed URL — and gates `GET /files/{id}` on envelope-participant
 * access. The in-tree operator's "bake at accept" simplicity is fine
 * for local-dev because URLs point at the same process and don't
 * expire. Operators with externally-signed URLs (CloudFront, etc.)
 * should pick the mint-on-read strategy.
 *
 * Access posture: the only file-level access check is that the
 * requester is an authenticated agent on this operator — the file
 * is delivered as-is. Operators that need stricter access control
 * layer additional checks at the route layer.
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import { mintFileId } from "./ids.js";
import { BadRequestError, NotFoundError } from "../errors.js";
import type { OperatorRepository } from "../storage/repository.js";
import type { FileRecord, Handle } from "../storage/types.js";

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const MAX_FILENAME_LENGTH = 180;

const ALLOWED_CONTENT_TYPES = new Set<string>([
  "application/json",
  "application/pdf",
  "image/gif",
  "image/jpeg",
  "image/png",
  "text/csv",
  "text/markdown",
  "text/plain",
  "application/octet-stream",
]);

const MAGIC_BYTES: Record<string, readonly Uint8Array[]> = {
  "application/pdf": [new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])],
  "image/gif": [
    new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]),
    new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]),
  ],
  "image/jpeg": [new Uint8Array([0xff, 0xd8, 0xff])],
  "image/png": [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  ],
};

const UNSAFE_FILENAME = /[^A-Za-z0-9._ -]+/g;

export interface FileServiceConfig {
  readonly host: string;
  readonly port: number;
  readonly filesDir: string;
}

export interface UploadInput {
  readonly ownerHandle: Handle;
  readonly filename: string;
  readonly contentType: string;
  readonly bytes: Buffer;
}

/**
 * Upload metadata returned to the sender. The in-tree operator stamps
 * a 24-hour expiry to mirror the canonical Robot Networks shape; the
 * file is reachable via `GET /files/{id}` until `expiresAt` (a stub
 * for the dev-only operator — no GC runs in this process).
 */
export interface UploadResult {
  readonly id: string;
  readonly status: "ready";
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly createdAt: number;
  readonly expiresAt: number;
}

const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

export class FileService {
  readonly #repo: OperatorRepository;
  readonly #config: FileServiceConfig;

  constructor(repo: OperatorRepository, config: FileServiceConfig) {
    this.#repo = repo;
    this.#config = config;
  }

  buildFileUrl(id: string): string {
    return `http://${this.#config.host}:${this.#config.port}/files/${encodeURIComponent(id)}`;
  }

  upload(input: UploadInput): UploadResult {
    const safeName = sanitizeFilename(input.filename);
    const contentType = validateContentType(input.contentType);
    if (input.bytes.length === 0) {
      throw new BadRequestError("file cannot be empty", "INVALID_FILE");
    }
    if (input.bytes.length > MAX_FILE_SIZE_BYTES) {
      throw new BadRequestError(
        "file exceeds maximum size of 10MB",
        "INVALID_FILE",
      );
    }
    validateMagicBytes(contentType, input.bytes);

    const id = mintFileId();
    const relativePath = path.join(id, safeName);
    const absolutePath = path.join(this.#config.filesDir, relativePath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, input.bytes, { mode: 0o600 });

    this.#repo.files.register({
      id,
      ownerHandle: input.ownerHandle,
      filename: safeName,
      contentType,
      sizeBytes: input.bytes.length,
      relativePath,
    });
    const createdAt = Date.now();
    return {
      id,
      status: "ready",
      filename: safeName,
      contentType,
      sizeBytes: input.bytes.length,
      createdAt,
      expiresAt: createdAt + UPLOAD_TTL_MS,
    };
  }

  /** Read the bytes for a stored file. The caller is responsible for
   *  the authentication check at the route layer. */
  serveById(id: string): { row: FileRecord; bytes: Buffer } {
    const row = this.#repo.files.byId(id);
    if (row === null) {
      throw new NotFoundError("not found");
    }
    const absolute = path.join(this.#config.filesDir, row.relativePath);
    let bytes: Buffer;
    try {
      bytes = readFileSync(absolute);
    } catch {
      throw new NotFoundError("not found");
    }
    if (statSync(absolute).size !== bytes.length) {
      throw new NotFoundError("not found");
    }
    return { row, bytes };
  }
}

export function sanitizeFilename(filename: string): string {
  const baseName = path.basename(filename).trim().replace(/^\.+|\.+$/g, "");
  if (baseName.length === 0) return "file";
  const safe = baseName.replace(UNSAFE_FILENAME, "_").trim();
  if (safe.length === 0) return "file";
  return safe.slice(0, MAX_FILENAME_LENGTH);
}

function validateContentType(raw: string): string {
  const normalized = (raw || "").split(";", 1)[0]!.trim().toLowerCase();
  if (!ALLOWED_CONTENT_TYPES.has(normalized)) {
    throw new BadRequestError(
      `content type not allowed: ${normalized || "<missing>"}`,
      "INVALID_FILE",
    );
  }
  return normalized;
}

function validateMagicBytes(contentType: string, bytes: Buffer): void {
  const expected = MAGIC_BYTES[contentType];
  if (expected === undefined) return;
  for (const sig of expected) {
    if (bytes.length < sig.length) continue;
    let match = true;
    for (let i = 0; i < sig.length; i++) {
      if (bytes[i] !== sig[i]) {
        match = false;
        break;
      }
    }
    if (match) return;
  }
  throw new BadRequestError(
    "file content does not match declared content type",
    "INVALID_FILE",
  );
}
