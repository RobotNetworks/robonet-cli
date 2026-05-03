import { describe, it } from "node:test";
import * as assert from "node:assert/strict";

import { AesGcmEncryptor } from "../src/credentials/aes-encryptor.js";
import { UnsafePlaintextEncryptor } from "../src/credentials/crypto.js";
import {
  buildProductionEncryptor,
  type KeychainEntry,
} from "../src/credentials/keychain.js";

interface StubEntryState {
  password: string | null;
  setCalls: number;
  getCalls: number;
  failGet?: Error;
  failSet?: Error;
}

function stubEntry(state: StubEntryState): KeychainEntry {
  return {
    getPassword(): string | null {
      state.getCalls += 1;
      if (state.failGet) throw state.failGet;
      return state.password;
    },
    setPassword(value: string): void {
      state.setCalls += 1;
      if (state.failSet) throw state.failSet;
      state.password = value;
    },
    deletePassword(): boolean {
      const had = state.password !== null;
      state.password = null;
      return had;
    },
  };
}

describe("buildProductionEncryptor", () => {
  it("first call generates a key, persists it, and returns an AES encryptor", async () => {
    const state: StubEntryState = { password: null, setCalls: 0, getCalls: 0 };
    const enc = await buildProductionEncryptor({
      entryFactory: () => stubEntry(state),
    });
    assert.ok(enc instanceof AesGcmEncryptor);
    assert.equal(state.setCalls, 1, "should persist a fresh key");
    assert.equal(state.getCalls, 1);
    assert.ok(state.password !== null);
    // Persisted as base64 of a 32-byte key → ≥ 43 chars.
    assert.ok(state.password!.length >= 43);
  });

  it("subsequent calls read the existing key and skip the set", async () => {
    const state: StubEntryState = { password: null, setCalls: 0, getCalls: 0 };
    const enc1 = await buildProductionEncryptor({
      entryFactory: () => stubEntry(state),
    });
    const enc2 = await buildProductionEncryptor({
      entryFactory: () => stubEntry(state),
    });
    assert.equal(state.setCalls, 1, "set runs only once");
    // Both encryptors should round-trip the same blob.
    const blob = (enc1 as AesGcmEncryptor).encrypt("hello");
    assert.equal((enc2 as AesGcmEncryptor).decrypt(blob), "hello");
  });

  it("degrades to plaintext with a warning when get throws", async () => {
    const state: StubEntryState = {
      password: null,
      setCalls: 0,
      getCalls: 0,
      failGet: new Error("dbus unavailable"),
    };
    const warns: string[] = [];
    const enc = await buildProductionEncryptor({
      entryFactory: () => stubEntry(state),
      warn: (m) => warns.push(m),
    });
    assert.ok(enc instanceof UnsafePlaintextEncryptor);
    assert.equal(warns.length, 1);
    assert.match(warns[0], /keychain unavailable/);
    assert.match(warns[0], /dbus unavailable/);
  });

  it("degrades to plaintext with a warning when set throws", async () => {
    const state: StubEntryState = {
      password: null,
      setCalls: 0,
      getCalls: 0,
      failSet: new Error("write denied"),
    };
    const warns: string[] = [];
    const enc = await buildProductionEncryptor({
      entryFactory: () => stubEntry(state),
      warn: (m) => warns.push(m),
    });
    assert.ok(enc instanceof UnsafePlaintextEncryptor);
    assert.equal(warns.length, 1);
    assert.match(warns[0], /could not persist/);
    assert.match(warns[0], /write denied/);
  });

  it("uses the provided accountName for keychain lookup", async () => {
    let capturedAccount: string | null = null;
    const state: StubEntryState = { password: null, setCalls: 0, getCalls: 0 };
    await buildProductionEncryptor({
      accountName: "work-profile",
      entryFactory: (_service, account) => {
        capturedAccount = account;
        return stubEntry(state);
      },
    });
    assert.equal(capturedAccount, "work-profile");
  });
});
