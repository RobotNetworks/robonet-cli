/**
 * Operator-side file service.
 *
 * Mirrors the production backend's `FileService` minus S3: bytes live
 * in the per-network ``filesDir`` (sibling to ``operator.sqlite``);
 * download URLs are operator-served at ``GET /files/<id>``.
 *
 * Files start ``pending`` on upload and transition to ``attached`` once
 * a session message claims them by ``file_id``. The service validates
 * content type (allowlist + magic bytes) and size (10 MB max), mirroring
 * the production backend.
 */

import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import { mintId } from "./ids.js";
import { BadRequestError, NotFoundError } from "../errors.js";
import type { OperatorRepository, RegisterFileInput } from "../storage/repository.js";
import type { FileRecord, Handle, MessageId } from "../storage/types.js";

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const MAX_FILENAME_LENGTH = 180;
const PENDING_TTL_MS = 60 * 60 * 1000;

const ALLOWED_CONTENT_TYPES = new Set<string>([
  "application/json",
  "application/pdf",
  "image/gif",
  "image/jpeg",
  "image/png",
  "text/csv",
  "text/markdown",
  "text/plain",
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
  /** Operator host/port — used to build the download URL. */
  readonly host: string;
  readonly port: number;
  /** Per-network directory holding the bytes for every uploaded file. */
  readonly filesDir: string;
}

export interface UploadInput {
  readonly uploaderHandle: Handle;
  readonly filename: string;
  readonly contentType: string;
  readonly bytes: Buffer;
}

export interface UploadResult {
  readonly id: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly createdAtMs: number;
  readonly expiresAtMs: number | null;
}

export class FileService {
  readonly #repo: OperatorRepository;
  readonly #config: FileServiceConfig;

  constructor(repo: OperatorRepository, config: FileServiceConfig) {
    this.#repo = repo;
    this.#config = config;
  }

  /** ``http://<host>:<port>/files/<id>`` — what FilePart.url resolves to. */
  buildFileUrl(id: string): string {
    return `http://${this.#config.host}:${this.#config.port}/files/${encodeURIComponent(id)}`;
  }

  uploadFile(input: UploadInput): UploadResult {
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

    const id = mintId("file");
    const relativePath = path.join(id, safeName);
    const absolutePath = path.join(this.#config.filesDir, relativePath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, input.bytes, { mode: 0o600 });

    const expiresAtMs = Date.now() + PENDING_TTL_MS;
    const registerInput: RegisterFileInput = {
      id,
      uploaderHandle: input.uploaderHandle,
      filename: safeName,
      contentType,
      sizeBytes: input.bytes.length,
      relativePath,
      expiresAtMs,
    };
    const row = this.#repo.files.register(registerInput);
    return {
      id: row.id,
      filename: row.filename,
      contentType: row.contentType,
      sizeBytes: row.sizeBytes,
      createdAtMs: row.createdAtMs,
      expiresAtMs: row.expiresAtMs,
    };
  }

  /** Resolve a file_id reference against the sender's uploads.
   *
   *  Returns the file row when the requester owns a still-pending
   *  upload with that id. Throws ``NotFoundError`` with message
   *  ``"session not found"`` otherwise — the cross-uploader 404 must
   *  be indistinguishable from "this session doesn't exist for you"
   *  so callers can't probe other agents' uploads (mirrors the hosted
   *  Robot Networks operator's non-enumeration posture). */
  requirePendingForSender(fileId: string, senderHandle: Handle): FileRecord {
    const row = this.#repo.files.pendingForUploader(fileId, senderHandle);
    if (row === null) {
      throw new NotFoundError("session not found");
    }
    return row;
  }

  /** Flip ``pending`` → ``attached`` for ``fileIds`` against the
   *  message id minted by the caller. Returns the count actually
   *  claimed. Caller runs this inside the same transaction as the
   *  message insert. */
  claimForMessage(
    fileIds: readonly string[],
    sessionMessageId: MessageId,
    senderHandle: Handle,
  ): number {
    return this.#repo.files.claimMany(fileIds, sessionMessageId, senderHandle);
  }

  /** Read the bytes for a stored file (pending OR attached). The caller
   *  is responsible for the eligibility check — this method is the
   *  filesystem-read primitive only. */
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
    // Defence-in-depth: drift between disk and DB is a bug worth
    // surfacing. Use the actual byte count for downstream headers.
    if (statSync(absolute).size !== bytes.length) {
      throw new NotFoundError("not found");
    }
    return { row, bytes };
  }

  /** Delete pending files past their TTL. Returns the count cleaned up. */
  sweepExpiredPending(now = Date.now()): number {
    const expired = this.#repo.files.expiredPending(now);
    let removed = 0;
    for (const row of expired) {
      const absolute = path.join(this.#config.filesDir, row.relativePath);
      try {
        unlinkSync(absolute);
      } catch {
        // Best-effort — the row is forfeit either way.
      }
      if (this.#repo.files.removePending(row.id)) removed++;
    }
    return removed;
  }
}

/* ------------------------------------------------------------------ */
/* Content rewrite (file_id → url) for inbound message bodies         */
/* ------------------------------------------------------------------ */

export interface ResolvedContent {
  /** Content as the caller will see it stored — the same shape they
   *  sent. ``file_id`` references pass through unchanged; receivers
   *  call ``GET /files/{file_id}`` to mint a fresh URL. */
  readonly content: unknown;
  /** File ids that should be claimed once the message id is minted. */
  readonly fileIds: readonly string[];
}

/**
 * Validate ``file_id`` references on inbound content. ``FilePart`` /
 * ``ImagePart`` parts carrying a ``file_id`` are looked up against the
 * sender's pending uploads — missing or cross-uploader references
 * raise a 404 (non-enumeration). The content itself passes through
 * UNCHANGED: the durable transcript carries ``file_id`` exactly as
 * the sender supplied it. Receivers call ``GET /files/{file_id}``
 * to mint a fresh signed URL on demand, so nothing in the transcript
 * ever goes stale.
 */
export function resolveContentFiles(
  content: unknown,
  files: FileService,
  senderHandle: Handle,
): ResolvedContent {
  if (typeof content === "string") {
    return { content, fileIds: [] };
  }
  if (!Array.isArray(content)) {
    return { content, fileIds: [] };
  }
  const fileIds: string[] = [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const obj = part as Record<string, unknown>;
    const partType = obj.type;
    const partFileId = obj.file_id;
    if (
      (partType === "file" || partType === "image") &&
      typeof partFileId === "string" &&
      partFileId.length > 0
    ) {
      // Validate ownership + pending status; throws NotFoundError on
      // miss. The returned row is unused — we don't rewrite the part.
      files.requirePendingForSender(partFileId, senderHandle);
      fileIds.push(partFileId);
    }
  }
  // Pass content through unchanged.
  return { content, fileIds };
}

/** Lightweight pre-check: does the content carry any ``file_id`` parts?
 *  Used by callers that want to fail closed when ``FileService`` isn't
 *  wired but a request asks for file resolution. */
export function containsFileId(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const obj = part as Record<string, unknown>;
    if (
      (obj.type === "file" || obj.type === "image") &&
      typeof obj.file_id === "string" &&
      obj.file_id.length > 0
    ) {
      return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Validation helpers                                                  */
/* ------------------------------------------------------------------ */

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
