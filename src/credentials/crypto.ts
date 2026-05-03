/**
 * Encryption interface for sensitive blobs in the credential store.
 *
 * The store wraps every secret column (`*_ciphertext`) through this interface
 * so the encryption strategy is swappable. Today the only implementation is
 * {@link PlaintextEncryptor}, which writes the value as-is — filesystem
 * permissions (mode 0600) are the only protection.
 *
 * Production will swap in a Keychain-backed implementation:
 *   - macOS Keychain holds a per-machine AES-256-GCM key
 *   - blobs are encrypted with that key (12-byte nonce prefix, 16-byte tag)
 *   - the same shape works for Linux Secret Service / Windows DPAPI
 *
 * The wire format `{nonce|ciphertext|tag}` is identical across implementations,
 * so flipping from plaintext to keychain is a one-line factory swap, no schema
 * change.
 */
export interface Encryptor {
  encrypt(plaintext: string): Buffer;
  decrypt(ciphertext: Buffer): string;
}

/**
 * Identity passthrough — stores plaintext as UTF-8 bytes. Use only when the
 * filesystem perm boundary (mode 0600) is acceptable. Marked unsafe in the
 * name so it's hard to accidentally reach for.
 */
export class UnsafePlaintextEncryptor implements Encryptor {
  encrypt(plaintext: string): Buffer {
    return Buffer.from(plaintext, "utf8");
  }
  decrypt(ciphertext: Buffer): string {
    return ciphertext.toString("utf8");
  }
}
