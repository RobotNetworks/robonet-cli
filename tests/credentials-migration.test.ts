import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { migrateLegacyCredentials } from "../src/credentials/migration.js";
import { CredentialStore } from "../src/credentials/store.js";
import {
  writeLegacyAdminToken as writeAdminToken,
  writeLegacyAgentCredential as writeAgentCredential,
} from "./legacy-file-fixtures.js";

let tmpDir: string;
let stateDir: string;
let dbPath: string;
let store: CredentialStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "robotnet-mig-test-"));
  stateDir = path.join(tmpDir, "state");
  dbPath = path.join(tmpDir, "credentials.sqlite");
  store = CredentialStore.open(dbPath);
});

afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("migrateLegacyCredentials", () => {
  it("ingests admin and agent files into the store and removes the originals", async () => {
    await writeAdminToken(stateDir, "local", "admin-tok");
    await writeAgentCredential(stateDir, "local", "@cli.bot", "agent-tok-1");
    await writeAgentCredential(stateDir, "local", "@peer.bot", "agent-tok-2");

    const summary = await migrateLegacyCredentials({
      store,
      profileStateDir: stateDir,
      networkNames: ["local"],
    });

    assert.deepEqual(summary, {
      adminTokensMigrated: 1,
      agentCredentialsMigrated: 2,
      userSessionsMigrated: 0,
    });

    assert.equal(store.getLocalAdminToken("local")?.token, "admin-tok");
    assert.equal(store.getAgentCredential("local", "@cli.bot")?.bearer, "agent-tok-1");
    assert.equal(store.getAgentCredential("local", "@peer.bot")?.bearer, "agent-tok-2");

    // Files removed.
    assert.equal(
      fs.existsSync(path.join(stateDir, "networks", "local", "admin.token")),
      false,
    );
    assert.equal(
      fs.readdirSync(path.join(stateDir, "networks", "local", "credentials")).length,
      0,
    );
  });

  it("is idempotent — re-running on a clean state migrates zero", async () => {
    await writeAdminToken(stateDir, "local", "admin-tok");
    await migrateLegacyCredentials({
      store,
      profileStateDir: stateDir,
      networkNames: ["local"],
    });
    const second = await migrateLegacyCredentials({
      store,
      profileStateDir: stateDir,
      networkNames: ["local"],
    });
    assert.deepEqual(second, {
      adminTokensMigrated: 0,
      agentCredentialsMigrated: 0,
      userSessionsMigrated: 0,
    });
  });

  it("does not overwrite a value already in the store", async () => {
    store.putLocalAdminToken("local", "store-wins");
    await writeAdminToken(stateDir, "local", "file-loses");

    const summary = await migrateLegacyCredentials({
      store,
      profileStateDir: stateDir,
      networkNames: ["local"],
    });

    // Store-side value wins; file is left in place because the migration
    // skipped it.
    assert.equal(summary.adminTokensMigrated, 0);
    assert.equal(store.getLocalAdminToken("local")?.token, "store-wins");
    assert.equal(
      fs.existsSync(path.join(stateDir, "networks", "local", "admin.token")),
      true,
    );
  });

  it("handles networks with no legacy state without error", async () => {
    const summary = await migrateLegacyCredentials({
      store,
      profileStateDir: stateDir,
      networkNames: ["local", "global"],
    });
    assert.deepEqual(summary, {
      adminTokensMigrated: 0,
      agentCredentialsMigrated: 0,
      userSessionsMigrated: 0,
    });
  });

  it("ignores non-`.token` files in the credentials dir", async () => {
    await writeAgentCredential(stateDir, "local", "@cli.bot", "tok");
    fs.writeFileSync(
      path.join(stateDir, "networks", "local", "credentials", "README"),
      "ignored",
    );
    const summary = await migrateLegacyCredentials({
      store,
      profileStateDir: stateDir,
      networkNames: ["local"],
    });
    assert.equal(summary.agentCredentialsMigrated, 1);
    // README is untouched (not a .token file).
    assert.equal(
      fs.existsSync(path.join(stateDir, "networks", "local", "credentials", "README")),
      true,
    );
  });

  it("ingests a legacy auth.json into user_sessions and removes the file", async () => {
    const legacyFile = path.join(tmpDir, "auth.json");
    fs.writeFileSync(
      legacyFile,
      JSON.stringify({
        auth_mode: "pkce",
        access_token: "user-tok",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "openid profile email",
        resource: "https://api.example.test/v1",
        token_endpoint: "https://auth.example.test/token",
        client_id: "client_xyz",
        redirect_uri: "http://127.0.0.1:9876/callback",
        refresh_token: "rt-xxx",
      }),
    );

    const summary = await migrateLegacyCredentials({
      store,
      profileStateDir: stateDir,
      networkNames: [],
      legacyUserSessionFile: legacyFile,
    });
    assert.equal(summary.userSessionsMigrated, 1);

    const session = store.getUserSession();
    assert.ok(session);
    assert.equal(session!.accessToken, "user-tok");
    assert.equal(session!.refreshToken, "rt-xxx");
    assert.equal(session!.clientId, "client_xyz");
    assert.equal(session!.tokenEndpoint, "https://auth.example.test/token");
    assert.equal(session!.authMode, "pkce");
    // Legacy expiresIn is dropped — see note in migrateLegacyUserSession.
    assert.equal(session!.accessTokenExpiresAt, null);
    // File removed.
    assert.equal(fs.existsSync(legacyFile), false);
  });

  it("ingest is idempotent — second run does not duplicate the user session", async () => {
    const legacyFile = path.join(tmpDir, "auth.json");
    fs.writeFileSync(
      legacyFile,
      JSON.stringify({
        auth_mode: "pkce",
        access_token: "tok",
        token_type: "Bearer",
        expires_in: 3600,
        resource: "https://api.example.test/v1",
        token_endpoint: "https://auth.example.test/token",
        client_id: "ci",
      }),
    );
    await migrateLegacyCredentials({
      store,
      profileStateDir: stateDir,
      networkNames: [],
      legacyUserSessionFile: legacyFile,
    });
    // First run consumed the file. Re-creating the file with a different
    // token shouldn't overwrite the migrated row — store wins on second pass.
    fs.writeFileSync(
      legacyFile,
      JSON.stringify({
        auth_mode: "pkce",
        access_token: "different-tok",
        token_type: "Bearer",
        expires_in: 3600,
        resource: "https://api.example.test/v1",
        token_endpoint: "https://auth.example.test/token",
        client_id: "ci",
      }),
    );
    const second = await migrateLegacyCredentials({
      store,
      profileStateDir: stateDir,
      networkNames: [],
      legacyUserSessionFile: legacyFile,
    });
    assert.equal(second.userSessionsMigrated, 0);
    // Original migrated value still in place.
    assert.equal(store.getUserSession()?.accessToken, "tok");
    // File untouched on the second pass since the row already existed.
    assert.equal(fs.existsSync(legacyFile), true);
  });

  it("skips credential files whose stems are not valid handles", async () => {
    await writeAgentCredential(stateDir, "local", "@cli.bot", "tok");
    fs.writeFileSync(
      path.join(stateDir, "networks", "local", "credentials", "BADhandle.token"),
      "tok",
    );
    const summary = await migrateLegacyCredentials({
      store,
      profileStateDir: stateDir,
      networkNames: ["local"],
    });
    // Only the valid one migrates; the bad one is left on disk.
    assert.equal(summary.agentCredentialsMigrated, 1);
    assert.equal(
      fs.existsSync(
        path.join(stateDir, "networks", "local", "credentials", "BADhandle.token"),
      ),
      true,
    );
  });
});
