import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import { RobotNetCLIError } from "../errors.js";
import type { Encryptor } from "./crypto.js";

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;

export class CredentialDecryptionError extends RobotNetCLIError {
  constructor(message: string) {
    super(message);
    this.name = "CredentialDecryptionError";
  }
}

/**
 * Authenticated AES-256-GCM encryptor.
 *
 * Wire format on disk: `[12-byte nonce][ciphertext][16-byte tag]`. The tag
 * authenticates both the ciphertext and the (zero-length) AAD; tampering
 * with any byte trips a {@link CredentialDecryptionError} on read.
 *
 * Construct via {@link AesGcmEncryptor.fromKey} so the key length is
 * validated up front.
 */
export class AesGcmEncryptor implements Encryptor {
  readonly #key: Buffer;

  private constructor(key: Buffer) {
    this.#key = key;
  }

  /** Build an encryptor from a 32-byte symmetric key. */
  static fromKey(key: Buffer): AesGcmEncryptor {
    if (key.length !== KEY_LENGTH) {
      throw new RobotNetCLIError(
        `AesGcmEncryptor expects a ${KEY_LENGTH}-byte key (got ${key.length})`,
      );
    }
    return new AesGcmEncryptor(key);
  }

  /** Generate a fresh random key. Use only for first-time setup. */
  static generateKey(): Buffer {
    return randomBytes(KEY_LENGTH);
  }

  encrypt(plaintext: string): Uint8Array {
    const nonce = randomBytes(NONCE_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.#key, nonce);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([nonce, ct, tag]);
  }

  decrypt(blob: Uint8Array): string {
    if (blob.length < NONCE_LENGTH + TAG_LENGTH) {
      throw new CredentialDecryptionError(
        `ciphertext too short (${blob.length} bytes; minimum ${NONCE_LENGTH + TAG_LENGTH})`,
      );
    }
    const nonce = blob.subarray(0, NONCE_LENGTH);
    const tag = blob.subarray(blob.length - TAG_LENGTH);
    const ct = blob.subarray(NONCE_LENGTH, blob.length - TAG_LENGTH);
    const decipher = createDecipheriv(ALGORITHM, this.#key, nonce);
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
    } catch (err) {
      throw new CredentialDecryptionError(
        `decryption failed — credential store may be corrupt or its key has changed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

/**
 * Constant-time equality on two buffers. Exposed so test code can compare
 * a known nonce/tag pair without leaking timing information; production
 * paths get this via Node's GCM tag verification automatically.
 */
export function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
