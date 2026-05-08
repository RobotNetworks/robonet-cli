import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { AesGcmEncryptor } from "../src/credentials/aes-encryptor.js";
import { buildFileBackedEncryptor } from "../src/credentials/file-key.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "robotnet-file-key-"));
}

describe("buildFileBackedEncryptor", () => {
  it("first call mints a 32-byte AES key at mode 0600", () => {
    const dir = tmpDir();
    try {
      const keyPath = path.join(dir, "credential-store-key");
      const enc = buildFileBackedEncryptor({ keyFilePath: keyPath });

      assert.ok(enc instanceof AesGcmEncryptor);
      assert.equal(fs.existsSync(keyPath), true);
      // POSIX mode bits — Windows file system doesn't enforce 0600 the same
      // way; skip the mode assertion off-POSIX so the test stays portable.
      if (process.platform !== "win32") {
        const stat = fs.statSync(keyPath);
        assert.equal((stat.mode & 0o777).toString(8), "600");
      }
      const raw = fs.readFileSync(keyPath, "utf-8").trim();
      // Base64 of 32 bytes is 44 chars including the trailing `=`.
      assert.equal(raw.length, 44);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("subsequent calls read the existing key without re-minting", () => {
    const dir = tmpDir();
    try {
      const keyPath = path.join(dir, "credential-store-key");
      const known = AesGcmEncryptor.generateKey();
      fs.writeFileSync(keyPath, known.toString("base64"), { mode: 0o600 });
      const before = fs.readFileSync(keyPath, "utf-8");

      const enc = buildFileBackedEncryptor({ keyFilePath: keyPath });
      const after = fs.readFileSync(keyPath, "utf-8");

      const ct = enc.encrypt("hello");
      assert.equal(enc.decrypt(ct), "hello");
      assert.equal(before, after);
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
