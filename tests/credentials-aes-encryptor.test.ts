import { describe, it } from "node:test";
import * as assert from "node:assert/strict";

import {
  AesGcmEncryptor,
  CredentialDecryptionError,
} from "../src/credentials/aes-encryptor.js";
import { RobotNetCLIError } from "../src/errors.js";

describe("AesGcmEncryptor", () => {
  it("round-trips utf-8 strings cleanly", () => {
    const enc = AesGcmEncryptor.fromKey(AesGcmEncryptor.generateKey());
    const samples = ["", "x", "Hello, world!", "🤖🔑 with emoji", "a".repeat(10_000)];
    for (const plaintext of samples) {
      const blob = enc.encrypt(plaintext);
      assert.equal(enc.decrypt(blob), plaintext);
    }
  });

  it("produces ciphertext that is not the literal plaintext bytes", () => {
    const enc = AesGcmEncryptor.fromKey(AesGcmEncryptor.generateKey());
    const blob = enc.encrypt("highly-secret-token");
    assert.notEqual(blob.toString("utf8"), "highly-secret-token");
    // Must include the 12-byte nonce + 16-byte tag overhead.
    assert.ok(blob.length >= 12 + "highly-secret-token".length + 16);
  });

  it("nonces are unique across calls (probabilistic)", () => {
    const enc = AesGcmEncryptor.fromKey(AesGcmEncryptor.generateKey());
    const nonces = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const blob = enc.encrypt("same-input");
      nonces.add(blob.subarray(0, 12).toString("hex"));
    }
    assert.equal(nonces.size, 1000, "12-byte random nonce should collide ~never in 1k draws");
  });

  it("rejects a key of the wrong length up front", () => {
    assert.throws(
      () => AesGcmEncryptor.fromKey(Buffer.alloc(31)),
      RobotNetCLIError,
    );
    assert.throws(
      () => AesGcmEncryptor.fromKey(Buffer.alloc(33)),
      RobotNetCLIError,
    );
  });

  it("decrypt throws on a tampered tag", () => {
    const enc = AesGcmEncryptor.fromKey(AesGcmEncryptor.generateKey());
    const blob = enc.encrypt("hello");
    blob[blob.length - 1] ^= 0x01; // flip a bit in the auth tag
    assert.throws(() => enc.decrypt(blob), CredentialDecryptionError);
  });

  it("decrypt throws on a tampered ciphertext byte", () => {
    const enc = AesGcmEncryptor.fromKey(AesGcmEncryptor.generateKey());
    const blob = enc.encrypt("hello world this is the ciphertext we will tamper");
    // Flip a bit roughly in the middle of the ciphertext segment.
    const target = 12 + 5; // skip the nonce
    blob[target] ^= 0x01;
    assert.throws(() => enc.decrypt(blob), CredentialDecryptionError);
  });

  it("decrypt throws when the blob is too short to contain nonce+tag", () => {
    const enc = AesGcmEncryptor.fromKey(AesGcmEncryptor.generateKey());
    assert.throws(
      () => enc.decrypt(Buffer.alloc(10)),
      (err: unknown) =>
        err instanceof CredentialDecryptionError &&
        err.message.includes("too short"),
    );
  });

  it("decrypt with a different key throws", () => {
    const k1 = AesGcmEncryptor.generateKey();
    const k2 = AesGcmEncryptor.generateKey();
    const blob = AesGcmEncryptor.fromKey(k1).encrypt("secret");
    assert.throws(
      () => AesGcmEncryptor.fromKey(k2).decrypt(blob),
      CredentialDecryptionError,
    );
  });
});
