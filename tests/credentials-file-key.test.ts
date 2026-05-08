import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { AesGcmEncryptor } from "../src/credentials/aes-encryptor.js";
import {
  buildFileBackedEncryptor,
  migrateLegacyKeychainStoreIfPresent,
} from "../src/credentials/file-key.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "robotnet-file-key-"));
}

describe("buildFileBackedEncryptor", () => {
  it("first call mints a 32-byte AES key at mode 0600", () => {
    const dir = tmpDir();
    try {
      const keyPath = path.join(dir, "credential-store-key");
      const notices: string[] = [];

      const enc = buildFileBackedEncryptor({
        keyFilePath: keyPath,
        notice: (m) => notices.push(m),
      });

      assert.ok(enc instanceof AesGcmEncryptor);
      assert.equal(fs.existsSync(keyPath), true);
      const stat = fs.statSync(keyPath);
      // POSIX mode bits — Windows file system doesn't enforce 0600 the same
      // way, but `fs.chmodSync` succeeds with no-op semantics there. Skip
      // the mode assertion off-POSIX to keep the test cross-platform.
      if (process.platform !== "win32") {
        assert.equal((stat.mode & 0o777).toString(8), "600");
      }
      const raw = fs.readFileSync(keyPath, "utf-8").trim();
      // Base64 of 32 bytes is 44 chars including the trailing `=`.
      assert.equal(raw.length, 44);
      assert.equal(notices.length, 1);
      assert.match(notices[0], /minted credential-store key/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("subsequent calls read the existing key without re-minting", () => {
    const dir = tmpDir();
    try {
      const keyPath = path.join(dir, "credential-store-key");
      // Hand-place a known key.
      const known = AesGcmEncryptor.generateKey();
      fs.writeFileSync(keyPath, known.toString("base64"), { mode: 0o600 });
      const before = fs.readFileSync(keyPath, "utf-8");
      const notices: string[] = [];

      const enc = buildFileBackedEncryptor({
        keyFilePath: keyPath,
        notice: (m) => notices.push(m),
      });
      const after = fs.readFileSync(keyPath, "utf-8");

      // The encryptor round-trips with the known key.
      const ct = enc.encrypt("hello");
      assert.equal(enc.decrypt(ct), "hello");
      // Key file content is unchanged (no re-mint).
      assert.equal(before, after);
      // No "minted" notice on a re-read.
      assert.equal(notices.length, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a malformed key with a clear error", () => {
    const dir = tmpDir();
    try {
      const keyPath = path.join(dir, "credential-store-key");
      // 16 bytes, not 32.
      fs.writeFileSync(keyPath, Buffer.alloc(16, 0xab).toString("base64"));
      assert.throws(
        () => buildFileBackedEncryptor({ keyFilePath: keyPath }),
        /16 bytes, expected 32/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("migrateLegacyKeychainStoreIfPresent", () => {
  it("moves an existing store aside when no key file is present", () => {
    const dir = tmpDir();
    try {
      const storePath = path.join(dir, "credentials.sqlite");
      const keyPath = path.join(dir, "credential-store-key");
      // Make a non-empty fake store; content doesn't matter for the test.
      fs.writeFileSync(storePath, "fake encrypted-with-keychain blob");
      const notices: string[] = [];

      migrateLegacyKeychainStoreIfPresent({
        storePath,
        keyFilePath: keyPath,
        notice: (m) => notices.push(m),
      });

      assert.equal(fs.existsSync(storePath), false);
      assert.equal(fs.existsSync(`${storePath}.legacy.bak`), true);
      assert.equal(notices.length, 1);
      assert.match(notices[0], /credential storage moved/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is a no-op when the key file already exists (post-migration)", () => {
    const dir = tmpDir();
    try {
      const storePath = path.join(dir, "credentials.sqlite");
      const keyPath = path.join(dir, "credential-store-key");
      fs.writeFileSync(storePath, "fresh-store-encrypted-with-the-file-key");
      fs.writeFileSync(keyPath, "...key...", { mode: 0o600 });
      const beforeStore = fs.readFileSync(storePath);
      const beforeKey = fs.readFileSync(keyPath);

      migrateLegacyKeychainStoreIfPresent({ storePath, keyFilePath: keyPath });

      assert.deepEqual(fs.readFileSync(storePath), beforeStore);
      assert.deepEqual(fs.readFileSync(keyPath), beforeKey);
      assert.equal(fs.existsSync(`${storePath}.legacy.bak`), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is a no-op when no store exists yet (fresh install)", () => {
    const dir = tmpDir();
    try {
      const storePath = path.join(dir, "credentials.sqlite");
      const keyPath = path.join(dir, "credential-store-key");

      migrateLegacyKeychainStoreIfPresent({ storePath, keyFilePath: keyPath });

      assert.equal(fs.existsSync(storePath), false);
      assert.equal(fs.existsSync(keyPath), false);
      assert.equal(fs.existsSync(`${storePath}.legacy.bak`), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not back up a 0-byte store (likely a test artifact)", () => {
    const dir = tmpDir();
    try {
      const storePath = path.join(dir, "credentials.sqlite");
      const keyPath = path.join(dir, "credential-store-key");
      fs.writeFileSync(storePath, ""); // empty file

      migrateLegacyKeychainStoreIfPresent({ storePath, keyFilePath: keyPath });

      assert.equal(fs.existsSync(`${storePath}.legacy.bak`), false);
      // The empty store stays in place — caller will overwrite or remove
      // it as part of the next CredentialStore.open.
      assert.equal(fs.existsSync(storePath), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
