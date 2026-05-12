/**
 * Encryption interface for sensitive blobs in the credential store.
 *
 * Production wraps every secret column (`*_ciphertext`) through an
 * {@link AesGcmEncryptor} keyed by a 32-byte AES key persisted at
 * `${configDir}/credential-store-key` (mode 0600). Tests inject the
 * {@link UnsafePlaintextEncryptor} so they don't touch the user's
 * config dir. The wire format is `{nonce|ciphertext|tag}`, identical
 * across implementations, so swapping the underlying key source is a
 * one-line factory change with no schema migration.
 */
export interface Encryptor {
  encrypt(plaintext: string): Uint8Array;
  decrypt(ciphertext: Uint8Array): string;
}

/**
 * Identity passthrough — stores plaintext as UTF-8 bytes. Use only when the
 * filesystem perm boundary (mode 0600) is acceptable. Marked unsafe in the
 * name so it's hard to accidentally reach for.
 */
export class UnsafePlaintextEncryptor implements Encryptor {
  encrypt(plaintext: string): Uint8Array {
    return new TextEncoder().encode(plaintext);
  }
  decrypt(ciphertext: Uint8Array): string {
    return new TextDecoder("utf-8", { fatal: false }).decode(ciphertext);
  }
}
