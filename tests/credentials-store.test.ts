import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import Database from "better-sqlite3";

import {
  CredentialStore,
  CredentialStoreError,
} from "../src/credentials/store.js";
import { CURRENT_SCHEMA_VERSION } from "../src/credentials/schema.js";

let tmpDir: string;
let dbPath: string;
let store: CredentialStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "robotnet-store-test-"));
  dbPath = path.join(tmpDir, "credentials.sqlite");
  store = CredentialStore.open(dbPath);
});

afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("CredentialStore.open", () => {
  it("creates the parent directory and the DB file", () => {
    const nested = path.join(tmpDir, "deeply", "nested", "credentials.sqlite");
    const s = CredentialStore.open(nested);
    try {
      assert.equal(fs.existsSync(nested), true);
    } finally {
      s.close();
    }
  });

  it("forces mode 0600 on the DB file (POSIX)", () => {
    if (process.platform === "win32") return;
    const mode = fs.statSync(dbPath).mode & 0o777;
    assert.equal(mode, 0o600);
  });

  it("applies migrations and reports CURRENT_SCHEMA_VERSION", () => {
    assert.equal(store.schemaVersion, CURRENT_SCHEMA_VERSION);
  });

  it("re-opens an existing DB without re-running migrations", () => {
    store.putAdminToken("local", "tok-1");
    store.close();

    const reopened = CredentialStore.open(dbPath);
    try {
      assert.equal(reopened.schemaVersion, CURRENT_SCHEMA_VERSION);
      assert.equal(reopened.getAdminToken("local")?.token, "tok-1");
    } finally {
      reopened.close();
    }
  });

  it("rejects a DB with a future schema version", () => {
    // Use a separate file so we don't interact with the shared `store`.
    const futurePath = path.join(tmpDir, "future.sqlite");
    const initial = CredentialStore.open(futurePath);
    initial.close();
    const db = new Database(futurePath);
    db.prepare("UPDATE schema_version SET version = ?")
      .run(CURRENT_SCHEMA_VERSION + 1);
    db.close();

    assert.throws(
      () => CredentialStore.open(futurePath),
      (err: unknown) =>
        err instanceof CredentialStoreError &&
        err.message.includes("newer than this CLI supports"),
    );
  });
});

describe("admin tokens", () => {
  it("round-trips through put/get with encryption applied", () => {
    store.putAdminToken("local", "admin-tok");
    const got = store.getAdminToken("local");
    assert.ok(got);
    assert.equal(got!.token, "admin-tok");
    assert.equal(got!.networkName, "local");
    assert.ok(got!.issuedAt > 0);
    assert.ok(got!.updatedAt > 0);
  });

  it("upserts on conflict", () => {
    store.putAdminToken("local", "tok-1");
    const first = store.getAdminToken("local")!;
    // Wait at least one ms so updated_at can move.
    const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    sleep(2);
    store.putAdminToken("local", "tok-2");
    const second = store.getAdminToken("local")!;
    assert.equal(second.token, "tok-2");
    assert.ok(second.updatedAt >= first.updatedAt);
  });

  it("returns null for an unknown network", () => {
    assert.equal(store.getAdminToken("ghost"), null);
  });

  it("delete returns true once and false on the second call", () => {
    store.putAdminToken("local", "tok");
    assert.equal(store.deleteAdminToken("local"), true);
    assert.equal(store.deleteAdminToken("local"), false);
    assert.equal(store.getAdminToken("local"), null);
  });

  it("token is stored in the token_ciphertext BLOB column", () => {
    store.putAdminToken("local", "highly-secret-token-xyz");
    store.close();
    const db = new Database(dbPath);
    const row = db
      .prepare("SELECT token_ciphertext FROM admin_tokens WHERE network_name = ?")
      .get("local") as { token_ciphertext: Buffer };
    db.close();
    // With UnsafePlaintextEncryptor the bytes ARE the utf8 of the token —
    // confirms the write path actually uses the encrypted column. Once the
    // Keychain encryptor lands, this assertion flips to assert.notEqual().
    assert.equal(row.token_ciphertext.toString("utf8"), "highly-secret-token-xyz");
    // Reopen so afterEach can close cleanly.
    store = CredentialStore.open(dbPath);
  });
});

describe("agent credentials — local_bearer", () => {
  it("round-trips a local_bearer row", () => {
    store.putAgentCredential({
      networkName: "local",
      handle: "@cli.bot",
      kind: "local_bearer",
      bearer: "tok-1",
    });
    const got = store.getAgentCredential("local", "@cli.bot");
    assert.ok(got);
    assert.equal(got!.kind, "local_bearer");
    assert.equal(got!.bearer, "tok-1");
    assert.equal(got!.bearerExpiresAt, null);
    assert.equal(got!.refreshToken, null);
    assert.equal(got!.clientId, null);
  });

  it("rejects oauth fields on a local_bearer row", () => {
    assert.throws(
      () =>
        store.putAgentCredential({
          networkName: "local",
          handle: "@cli.bot",
          kind: "local_bearer",
          bearer: "tok",
          refreshToken: "rt",
        }),
      CredentialStoreError,
    );
  });
});

describe("agent credentials — oauth_pkce", () => {
  it("round-trips a refresh-tokened row", () => {
    store.putAgentCredential({
      networkName: "public",
      handle: "@cli.bot",
      kind: "oauth_pkce",
      bearer: "access-tok",
      bearerExpiresAt: 1_777_700_000_000,
      refreshToken: "refresh-tok",
      clientId: "public-client-xxx",
      scope: "sessions:read sessions:write",
    });
    const got = store.getAgentCredential("public", "@cli.bot");
    assert.ok(got);
    assert.equal(got!.kind, "oauth_pkce");
    assert.equal(got!.bearer, "access-tok");
    assert.equal(got!.refreshToken, "refresh-tok");
    assert.equal(got!.clientId, "public-client-xxx");
    assert.equal(got!.bearerExpiresAt, 1_777_700_000_000);
    assert.equal(got!.scope, "sessions:read sessions:write");
  });

  it("requires client_id on an oauth_pkce row (refresh needs it)", () => {
    assert.throws(
      () =>
        store.putAgentCredential({
          networkName: "public",
          handle: "@cli.bot",
          kind: "oauth_pkce",
          bearer: "tok",
          // no clientId
        }),
      CredentialStoreError,
    );
  });

  it("rejects client_secret on an oauth_pkce row (PKCE is public)", () => {
    assert.throws(
      () =>
        store.putAgentCredential({
          networkName: "public",
          handle: "@cli.bot",
          kind: "oauth_pkce",
          bearer: "tok",
          clientId: "ci",
          clientSecret: "secret",
        }),
      CredentialStoreError,
    );
  });
});

describe("agent credentials — oauth_client_credentials", () => {
  it("round-trips a client-credentials row", () => {
    store.putAgentCredential({
      networkName: "public",
      handle: "@cli.bot",
      kind: "oauth_client_credentials",
      bearer: "access-tok",
      bearerExpiresAt: 1_777_700_000_000,
      clientId: "ci-xxx",
      clientSecret: "cs-xxx",
    });
    const got = store.getAgentCredential("public", "@cli.bot");
    assert.ok(got);
    assert.equal(got!.kind, "oauth_client_credentials");
    assert.equal(got!.clientId, "ci-xxx");
    assert.equal(got!.clientSecret, "cs-xxx");
    assert.equal(got!.refreshToken, null);
  });

  it("requires both client_id and client_secret", () => {
    assert.throws(
      () =>
        store.putAgentCredential({
          networkName: "public",
          handle: "@cli.bot",
          kind: "oauth_client_credentials",
          bearer: "tok",
          clientId: "ci",
          // no clientSecret
        }),
      CredentialStoreError,
    );
  });

  it("rejects refresh_token", () => {
    assert.throws(
      () =>
        store.putAgentCredential({
          networkName: "public",
          handle: "@cli.bot",
          kind: "oauth_client_credentials",
          bearer: "tok",
          clientId: "ci",
          clientSecret: "cs",
          refreshToken: "rt",
        }),
      CredentialStoreError,
    );
  });
});

describe("purgeUnreadableRows", () => {
  it("returns 0/0 when every row decrypts cleanly", async () => {
    store.putAdminToken("local", "admin-tok");
    store.putAgentCredential({
      networkName: "local",
      handle: "@cli.bot",
      kind: "local_bearer",
      bearer: "tok-1",
    });
    const out = store.purgeUnreadableRows();
    assert.deepEqual(out, { adminTokens: 0, agentCredentials: 0, userSessions: 0 });
    assert.equal(store.countAdminTokens(), 1);
    assert.equal(store.countAgentCredentials(), 1);
  });

  it("deletes admin and agent rows whose ciphertext is corrupt", async () => {
    const { AesGcmEncryptor } = await import(
      "../src/credentials/aes-encryptor.js"
    );

    // Use a real AES encryptor, then corrupt the on-disk bytes manually.
    const encrypted = path.join(tmpDir, "encrypted.sqlite");
    const enc = AesGcmEncryptor.fromKey(AesGcmEncryptor.generateKey());
    const s = CredentialStore.open(encrypted, { encryptor: enc });
    s.putAdminToken("local", "admin-tok");
    s.putAdminToken("staging", "staging-admin");
    s.putAgentCredential({
      networkName: "local",
      handle: "@cli.bot",
      kind: "local_bearer",
      bearer: "tok-1",
    });
    s.putAgentCredential({
      networkName: "staging",
      handle: "@migration.bot",
      kind: "local_bearer",
      bearer: "tok-2",
    });
    s.close();

    // Flip a byte in two specific rows' ciphertext so they fail to decrypt.
    const db = new Database(encrypted);
    db.prepare(
      `UPDATE admin_tokens SET token_ciphertext = X'00112233445566778899AABBCCDDEEFF' WHERE network_name = ?`,
    ).run("staging");
    db.prepare(
      `UPDATE agent_credentials SET bearer_ciphertext = X'00112233445566778899AABBCCDDEEFF' WHERE handle = ?`,
    ).run("@cli.bot");
    db.close();

    const reopened = CredentialStore.open(encrypted, { encryptor: enc });
    try {
      const result = reopened.purgeUnreadableRows();
      assert.deepEqual(result, { adminTokens: 1, agentCredentials: 1, userSessions: 0 });

      // Survivors stay intact.
      assert.equal(reopened.getAdminToken("local")?.token, "admin-tok");
      assert.equal(reopened.getAdminToken("staging"), null);
      assert.equal(reopened.getAgentCredential("local", "@cli.bot"), null);
      assert.equal(
        reopened.getAgentCredential("staging", "@migration.bot")?.bearer,
        "tok-2",
      );
    } finally {
      reopened.close();
    }
  });

  it("treats a row whose refresh_token_ciphertext is corrupt as unreadable", async () => {
    const { AesGcmEncryptor } = await import(
      "../src/credentials/aes-encryptor.js"
    );
    const encrypted = path.join(tmpDir, "rt-corrupt.sqlite");
    const enc = AesGcmEncryptor.fromKey(AesGcmEncryptor.generateKey());
    const s = CredentialStore.open(encrypted, { encryptor: enc });
    s.putAgentCredential({
      networkName: "public",
      handle: "@cli.bot",
      kind: "oauth_pkce",
      bearer: "access-tok",
      bearerExpiresAt: Date.now() + 3600_000,
      refreshToken: "rt-tok",
      clientId: "public-ci",
    });
    s.close();

    const db = new Database(encrypted);
    db.prepare(
      `UPDATE agent_credentials SET refresh_token_ciphertext = X'DEADBEEF'`,
    ).run();
    db.close();

    const reopened = CredentialStore.open(encrypted, { encryptor: enc });
    try {
      const result = reopened.purgeUnreadableRows();
      // Bearer is fine but refresh_token corrupt → row counts as unreadable.
      assert.equal(result.agentCredentials, 1);
      assert.equal(reopened.countAgentCredentials(), 0);
    } finally {
      reopened.close();
    }
  });
});

describe("agent credentials — list / delete", () => {
  it("listAgentCredentials returns rows for one network, sorted by handle", () => {
    store.putAgentCredential({
      networkName: "local",
      handle: "@bee.bot",
      kind: "local_bearer",
      bearer: "x",
    });
    store.putAgentCredential({
      networkName: "local",
      handle: "@apple.bot",
      kind: "local_bearer",
      bearer: "y",
    });
    store.putAgentCredential({
      networkName: "public",
      handle: "@cli.bot",
      kind: "oauth_pkce",
      bearer: "z",
      refreshToken: "rt",
      clientId: "public-ci",
    });

    const local = store.listAgentCredentials("local");
    assert.deepEqual(
      local.map((r) => r.handle),
      ["@apple.bot", "@bee.bot"],
    );
    const robotnet = store.listAgentCredentials("public");
    assert.deepEqual(
      robotnet.map((r) => r.handle),
      ["@cli.bot"],
    );
  });

  it("delete returns true once, false thereafter", () => {
    store.putAgentCredential({
      networkName: "local",
      handle: "@cli.bot",
      kind: "local_bearer",
      bearer: "tok",
    });
    assert.equal(store.deleteAgentCredential("local", "@cli.bot"), true);
    assert.equal(store.deleteAgentCredential("local", "@cli.bot"), false);
    assert.equal(store.getAgentCredential("local", "@cli.bot"), null);
  });
});
