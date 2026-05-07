import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { loadConfig } from "../src/config.js";
import { runDoctor, type DoctorCheck } from "../src/doctor.js";
import { isolatedXdg } from "./helpers.js";

let env: ReturnType<typeof isolatedXdg>;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  env = isolatedXdg();
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  env.cleanup();
  globalThis.fetch = originalFetch;
});

function indexByName(checks: readonly DoctorCheck[]): Record<string, DoctorCheck> {
  return Object.fromEntries(checks.map((c) => [c.name, c]));
}

describe("runDoctor — local network (auth-mode=agent-token)", () => {
  it("emits the local check set without OAuth probes", async () => {
    // Resolve the built-in `local` network so the doctor skips the OAuth
    // checks; mock fetch so the reachability probe doesn't hit the real loopback.
    globalThis.fetch = async () =>
      new Response("not implemented", { status: 404 });

    const config = loadConfig(undefined, { networkName: "local" });
    const checks = await runDoctor(config);
    const byName = indexByName(checks);

    assert.equal(byName.config_paths.ok, true);
    assert.equal(byName.network.ok, true);
    assert.match(byName.network.detail, /name=local/);
    assert.match(byName.network.detail, /auth_mode=agent-token/);
    // 404 is still a successful reachability probe.
    assert.equal(byName.network_reachable.ok, true);
    assert.equal(byName.credential_store.ok, true);
    assert.match(
      byName.credential_store.detail,
      /not yet created|schema_version=/,
    );
    // OAuth checks must be absent for agent-token networks.
    assert.equal("oauth_discovery" in byName, false);
    assert.equal("stored_user_session" in byName, false);
  });

  it("network_reachable=false when fetch errors", async () => {
    globalThis.fetch = async () => {
      throw new TypeError("fetch failed");
    };

    const config = loadConfig(undefined, { networkName: "local" });
    const checks = await runDoctor(config);
    const byName = indexByName(checks);

    assert.equal(byName.network_reachable.ok, false);
    assert.match(byName.network_reachable.detail, /fetch failed/);
  });
});

describe("runDoctor — remote network (auth-mode=oauth)", () => {
  it("includes OAuth discovery and stored_user_session", async () => {
    globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("oauth-protected-resource")) {
        return new Response(
          JSON.stringify({ resource: "https://api.example.test/v1" }),
          { status: 200 },
        );
      }
      if (url.includes("oauth-authorization-server")) {
        return new Response(
          JSON.stringify({
            authorization_endpoint: "https://auth.example.test/authorize",
            token_endpoint: "https://auth.example.test/token",
            registration_endpoint: "https://auth.example.test/register",
            resource_servers: [],
          }),
          { status: 200 },
        );
      }
      return new Response("ok", { status: 200 });
    };

    const config = loadConfig(undefined, { networkName: "public" });
    const checks = await runDoctor(config);
    const byName = indexByName(checks);

    assert.equal(byName.network.ok, true);
    assert.match(byName.network.detail, /auth_mode=oauth/);
    assert.equal(byName.oauth_discovery.ok, true);
    // No login → stored_user_session should be ok=false.
    assert.equal(byName.stored_user_session.ok, false);
    assert.match(byName.stored_user_session.detail, /run `robotnet login`/);
  });

  it("stored_user_session=true when a user session is in the credential store", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          authorization_endpoint: "https://auth.example.test/authorize",
          token_endpoint: "https://auth.example.test/token",
          registration_endpoint: "https://auth.example.test/register",
          resource_servers: [],
        }),
        { status: 200 },
      );

    const config = loadConfig(undefined, { networkName: "public" });
    const { CredentialStore } = await import("../src/credentials/store.js");
    const { UnsafePlaintextEncryptor } = await import(
      "../src/credentials/crypto.js"
    );
    const { credentialsStorePath } = await import(
      "../src/credentials/paths.js"
    );
    const store = CredentialStore.open(credentialsStorePath(config), {
      encryptor: new UnsafePlaintextEncryptor(),
    });
    store.putUserSession({
      accessToken: "tok",
      clientId: "client_123",
      tokenEndpoint: "https://auth.example.test/token",
      resource: "https://api.example.test/v1",
      authMode: "pkce",
    });
    store.close();

    const checks = await runDoctor(config);
    const byName = indexByName(checks);
    assert.equal(byName.stored_user_session.ok, true);
    assert.match(byName.stored_user_session.detail, /client_id=client_123/);
    assert.match(byName.stored_user_session.detail, /auth_mode=pkce/);
  });
});

describe("runDoctor — credential_store", () => {
  it("reports schema_version + counts when the store exists", async () => {
    globalThis.fetch = async () =>
      new Response("ok", { status: 200 });

    const config = loadConfig(undefined, { networkName: "local" });
    fs.mkdirSync(config.paths.configDir, { recursive: true });

    // Pre-populate the store via the lifecycle module's plaintext encryptor.
    const { CredentialStore } = await import("../src/credentials/store.js");
    const { UnsafePlaintextEncryptor } = await import(
      "../src/credentials/crypto.js"
    );
    const { credentialsStorePath } = await import(
      "../src/credentials/paths.js"
    );
    const store = CredentialStore.open(credentialsStorePath(config), {
      encryptor: new UnsafePlaintextEncryptor(),
    });
    store.putLocalAdminToken("local", "tok");
    store.putAgentCredential({
      networkName: "local",
      handle: "@cli.bot",
      kind: "local_bearer",
      bearer: "agent-tok",
    });
    store.close();

    const checks = await runDoctor(config);
    const byName = indexByName(checks);
    assert.equal(byName.credential_store.ok, true);
    assert.match(byName.credential_store.detail, /schema_version=\d+/);
    assert.match(byName.credential_store.detail, /local_admin_tokens=1/);
    assert.match(byName.credential_store.detail, /agent_credentials=1/);
  });
});

describe("runDoctor — directory_identity", () => {
  it("reports the bound agent and network when .robotnet/config.json exists in cwd", async () => {
    globalThis.fetch = async () =>
      new Response("ok", { status: 200 });

    const config = loadConfig(undefined, { networkName: "local" });
    const dotDir = path.join(env.tmpDir, ".robotnet");
    fs.mkdirSync(dotDir, { recursive: true });
    fs.writeFileSync(
      path.join(dotDir, "config.json"),
      JSON.stringify({
        network: "local",
        agent: "@cli.bot",
      }),
    );
    const cwd = process.cwd();
    process.chdir(env.tmpDir);
    try {
      const checks = await runDoctor(config);
      const byName = indexByName(checks);
      assert.equal(byName.directory_identity.ok, true);
      assert.match(byName.directory_identity.detail, /agent=@cli\.bot/);
      assert.match(byName.directory_identity.detail, /bound_to=local/);
    } finally {
      process.chdir(cwd);
    }
  });
});
