import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  existsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import { RobotNetCLIError } from "../errors.js";
import { AesGcmEncryptor } from "./aes-encryptor.js";
import type { Encryptor } from "./crypto.js";

/**
 * AES-256-GCM key persisted at a 0600 file alongside the credential store.
 * This is the default backend; matches what every unsigned npm/Homebrew CLI
 * ships (gh, aws, gcloud, npm). Same threat model as `~/.ssh/id_rsa`:
 *
 * - File mode `0600` blocks other UIDs on the box.
 * - Same UID can read either way — also true of the OS keychain in practice
 *   (the login keychain is unlocked the moment you sign into the user
 *   session, and any process under the same UID can request the entry).
 * - Disk-at-rest protection is FileVault, not the keychain or this file.
 *
 * The trade-off versus the keychain is a deliberate choice: the keychain
 * pins ACL to the calling binary's path + code signature, which on an
 * unsigned brew-distributed Node CLI means a fresh user prompt every
 * time the path changes (i.e. every `brew upgrade`). For a CLI run dozens
 * of times a day, that prompt cost outweighs the marginal security gain.
 */

const KEY_BYTES = 32;
const FILE_MODE = 0o600;

/**
 * Mint or read the credential-store key at ``keyFilePath``.
 *
 * - First call: writes a fresh 32-byte key, ``chmod 0600``.
 * - Subsequent calls: reads the existing key.
 * - Refuses to use a malformed key file (wrong length, bad base64) — the
 *   user can ``rm`` it and re-login if they want a clean slate.
 *
 * Returns an {@link Encryptor} backed by that key. Pure file IO; never
 * touches the OS keychain. No prompts, ever.
 */
export function buildFileBackedEncryptor(args: {
  readonly keyFilePath: string;
  /** Sink for one-time migration / mint notices. Defaults to process.stderr.write. */
  readonly notice?: (message: string) => void;
}): Encryptor {
  const notice = args.notice ?? ((m: string) => process.stderr.write(m));

  if (existsSync(args.keyFilePath)) {
    return AesGcmEncryptor.fromKey(readKey(args.keyFilePath));
  }

  // First mint. Make sure the parent directory exists; on macOS the
  // configDir is created lazily.
  mkdirSync(dirname(args.keyFilePath), { recursive: true });
  const fresh = AesGcmEncryptor.generateKey();
  writeKeyAtomic(args.keyFilePath, fresh);
  notice(
    `robotnet: minted credential-store key at ${args.keyFilePath} ` +
      `(mode 0600).\n`,
  );
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
        `Delete it and re-run; the CLI will mint a fresh one and you'll ` +
        `need to log in again.`,
    );
  }
  if (key.length !== KEY_BYTES) {
    throw new RobotNetCLIError(
      `credential-store key at ${path} is ${key.length} bytes, ` +
        `expected ${KEY_BYTES}. Delete it and re-run; the CLI will mint ` +
        `a fresh one and you'll need to log in again.`,
    );
  }
  return key;
}

/**
 * Write the key file atomically with mode 0600 from the moment of creation.
 *
 * `openSync(path, "wx", 0o600)` creates exclusive (fails if it exists) at
 * the right mode in one step, so there's no window where the file exists
 * with default permissions. Then we move it into place.
 *
 * `umask` could lower the actual mode, so we `chmodSync` after to be sure.
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

/**
 * One-time migration: when the new code first runs, an existing
 * `credentials.sqlite` is encrypted with the OLD keychain-backed key.
 * The user explicitly chose "wipe and force re-login," so move the
 * legacy store aside (kept as a `.legacy.bak` in case they need to
 * recover anything) and let the next call mint a fresh store.
 *
 * Detection: ``credentials.sqlite`` exists AND the new key file does
 * not. That's only true on the first run after the storage migration
 * lands; after that the key file is always present.
 */
export function migrateLegacyKeychainStoreIfPresent(args: {
  readonly storePath: string;
  readonly keyFilePath: string;
  readonly notice?: (message: string) => void;
}): void {
  const notice = args.notice ?? ((m: string) => process.stderr.write(m));
  if (!existsSync(args.storePath)) return;
  if (existsSync(args.keyFilePath)) return;

  // Sanity: if the existing store is a 0-byte file (some test harness
  // accident), don't bother backing it up.
  let sizeBytes = 0;
  try {
    sizeBytes = statSync(args.storePath).size;
  } catch {
    return;
  }
  if (sizeBytes === 0) return;

  const backupPath = `${args.storePath}.legacy.bak`;
  try {
    renameSync(args.storePath, backupPath);
  } catch (err) {
    throw new RobotNetCLIError(
      `failed to move legacy credential store ${args.storePath} aside ` +
        `to ${backupPath}: ${err instanceof Error ? err.message : String(err)}. ` +
        `Resolve the filesystem permissions and retry.`,
    );
  }
  notice(
    `robotnet: credential storage moved from OS keychain to a file-backed ` +
      `key (no more keychain prompts). Your previous credential store has ` +
      `been moved to ${backupPath}; you'll need to log in again. ` +
      `(See \`robotnet doctor\` for the current backend.)\n`,
  );
}
