import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import { RobotNetCLIError } from "../errors.js";
import { AesGcmEncryptor } from "./aes-encryptor.js";
import type { Encryptor } from "./crypto.js";

/**
 * AES-256-GCM key persisted to a 0600 file alongside the credential store.
 *
 * Same threat model as `~/.ssh/id_rsa`: file mode `0600` blocks other
 * UIDs; same UID can decrypt either way. Disk-at-rest protection is
 * FileVault, not this file. This is what every unsigned npm/Homebrew
 * CLI ships (gh, aws, gcloud, npm).
 */

const KEY_BYTES = 32;
const FILE_MODE = 0o600;

export function buildFileBackedEncryptor(args: {
  readonly keyFilePath: string;
}): Encryptor {
  if (existsSync(args.keyFilePath)) {
    return AesGcmEncryptor.fromKey(readKey(args.keyFilePath));
  }
  mkdirSync(dirname(args.keyFilePath), { recursive: true });
  const fresh = AesGcmEncryptor.generateKey();
  writeKeyAtomic(args.keyFilePath, fresh);
  return AesGcmEncryptor.fromKey(fresh);
}

function readKey(path: string): Buffer {
  const raw = readFileSync(path, "utf-8").trim();
  let key: Buffer;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    throw new RobotNetCLIError(
      `credential-store key at ${path} is not valid base64. ` +
        `Delete it (and credentials.sqlite) and re-login.`,
    );
  }
  if (key.length !== KEY_BYTES) {
    throw new RobotNetCLIError(
      `credential-store key at ${path} is ${key.length} bytes, ` +
        `expected ${KEY_BYTES}. Delete it (and credentials.sqlite) and re-login.`,
    );
  }
  return key;
}

/**
 * Atomic, mode-0600-from-creation write. `openSync(..., "wx", 0o600)`
 * fails if the path already exists, then `chmodSync` enforces the mode
 * (umask can lower it). Rename into place so concurrent processes never
 * see a half-written key.
 */
function writeKeyAtomic(path: string, key: Buffer): void {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    const fd = openSync(tmp, "wx", FILE_MODE);
    try {
      writeFileSync(fd, key.toString("base64"), { encoding: "utf-8" });
    } finally {
      closeSync(fd);
    }
    try {
      chmodSync(tmp, FILE_MODE);
    } catch {
      // best-effort
    }
    renameSync(tmp, path);
  } catch (err) {
    throw new RobotNetCLIError(
      `failed to write credential-store key at ${path}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
