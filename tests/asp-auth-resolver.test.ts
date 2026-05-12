import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  LocalAdminTokenNotFoundError,
  CredentialNotFoundError,
} from "../src/asp/credentials.js";
import { RobotNetCLIError } from "../src/errors.js";
import {
  writeLegacyAdminToken as writeAdminToken,
  writeLegacyAgentCredential as writeAgentCredential,
} from "./legacy-file-fixtures.js";
import {
  resolveAdminClient,
  resolveAdminToken,
  resolveAgentToken,
  resolveSessionClient,
} from "../src/asp/auth-resolver.js";
import type { CLIConfig, NetworkConfig } from "../src/config.js";
import { UnsafePlaintextEncryptor } from "../src/credentials/crypto.js";
import {
  _resetCredentialStoreCacheForTests,
  _setEncryptorForTests,
} from "../src/credentials/lifecycle.js";

let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "robotnet-resolver-test-"));
  _setEncryptorForTests(new UnsafePlaintextEncryptor());
});

afterEach(() => {
  _setEncryptorForTests(null);
  _resetCredentialStoreCacheForTests();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function makeConfig(network: NetworkConfig = {
  name: "local",
  url: "http://127.0.0.1:8723",
  authMode: "agent-token",
}): CLIConfig {
  return {
    profile: "default",
    profileSource: { kind: "default" },
    environment: "prod",
    paths: {
      configDir: path.join(stateDir, "config"),
      stateDir,
      logsDir: path.join(stateDir, "logs"),
      runDir: path.join(stateDir, "run"),
    },
    configFile: path.join(stateDir, "config", "config.json"),
    tokenStoreFile: path.join(stateDir, "config", "auth.json"),
    network,
    networkSource: { kind: "default" },
    networks: { [network.name]: network },
  };
}

describe("resolveAdminToken", () => {
  it("returns the override flag value when supplied, source = 'flag'", async () => {
    const out = await resolveAdminToken(makeConfig(), "explicit-tok");
    assert.deepEqual(out, { token: "explicit-tok", source: "flag" });
  });

  it("ingests a legacy admin.token file via store migration and reports source='store'", async () => {
    await writeAdminToken(stateDir, "local", "stored-tok");
    const out = await resolveAdminToken(makeConfig());
    assert.deepEqual(out, { token: "stored-tok", source: "store" });
  });

  it("throws LocalAdminTokenNotFoundError with no override and no file", async () => {
    await assert.rejects(
      resolveAdminToken(makeConfig()),
      LocalAdminTokenNotFoundError,
    );
  });

  it("an empty override is treated as 'not provided' rather than as an empty token", async () => {
    await assert.rejects(
      resolveAdminToken(makeConfig(), ""),
      LocalAdminTokenNotFoundError,
    );
  });
});

describe("resolveAdminClient", () => {
  it("constructs an AspAdminClient against the network's URL", async () => {
    let captured: { url: string; method: string; auth: string } | null = null;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      captured = {
        url: String(input),
        method: String(init?.method ?? "GET"),
        auth: ((init?.headers ?? {}) as Record<string, string>).Authorization ?? "",
      };
      return new Response(
        JSON.stringify({
          handle: "@cli.bot",
          token: "tok",
          policy: "allowlist",
          allowlist: [],
        }),
        { status: 200 },
      );
    };
    try {
      const client = await resolveAdminClient(makeConfig(), "admin-tok");
      await client.showAgent("@cli.bot");
      assert.ok(captured);
      assert.equal(
        captured!.url,
        "http://127.0.0.1:8723/_admin/agents/%40cli.bot",
      );
      assert.equal(captured!.auth, "Bearer admin-tok");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe("resolveAgentToken", () => {
  it("flag override wins", async () => {
    const out = await resolveAgentToken(makeConfig(), "@cli.bot", "explicit");
    assert.deepEqual(out, { token: "explicit", source: "flag" });
  });

  it("ingests a legacy per-agent credential file via store migration and reports source='store'", async () => {
    await writeAgentCredential(stateDir, "local", "@cli.bot", "stored");
    const out = await resolveAgentToken(makeConfig(), "@cli.bot");
    assert.deepEqual(out, { token: "stored", source: "store" });
  });

  it("throws CredentialNotFoundError when neither is present", async () => {
    await assert.rejects(
      resolveAgentToken(makeConfig(), "@cli.bot"),
      CredentialNotFoundError,
    );
  });
});

describe("resolveSessionClient", () => {
  it("returns a session client whose wsUrl points at the network's /connect", async () => {
    const client = await resolveSessionClient(makeConfig(), "@cli.bot", "tok");
    assert.equal(client.wsUrl, "ws://127.0.0.1:8723/connect");
    assert.equal(client.token, "tok");
  });
});

describe("resolveAgentToken — oauth_client_credentials renewal", () => {
  it("returns the cached bearer when it is still valid", async () => {
    const config = makeConfig({
      name: "global",
      url: "https://api.example/v1",
      authMode: "oauth",
      authBaseUrl: "https://auth.example",
      websocketUrl: "wss://ws.example",
    });
    // Seed the store with a still-valid bearer.
    const { openProcessCredentialStore } = await import(
      "../src/credentials/lifecycle.js"
    );
    const store = await openProcessCredentialStore(config);
    store.putAgentCredential({
      networkName: "global",
      handle: "@cli.bot",
      kind: "oauth_client_credentials",
      bearer: "live-bearer",
      bearerExpiresAt: Date.now() + 60_000,
      clientId: "ci",
      clientSecret: "cs",
    });
    // Any fetch invocation would be a bug — the cached value is fresh.
    globalThis.fetch = async () => {
      throw new Error("resolveAgentToken should not have minted a new bearer");
    };
    const out = await resolveAgentToken(config, "@cli.bot");
    assert.deepEqual(out, { token: "live-bearer", source: "store" });
  });

  it("renews via client_credentials when the cached bearer is expired", async () => {
    const config = makeConfig({
      name: "global",
      url: "https://api.example/v1",
      authMode: "oauth",
      authBaseUrl: "https://auth.example",
      websocketUrl: "wss://ws.example",
    });
    const { openProcessCredentialStore } = await import(
      "../src/credentials/lifecycle.js"
    );
    const store = await openProcessCredentialStore(config);
    store.putAgentCredential({
      networkName: "global",
      handle: "@cli.bot",
      kind: "oauth_client_credentials",
      bearer: "stale-bearer",
      bearerExpiresAt: Date.now() - 10_000, // already expired
      clientId: "ci",
      clientSecret: "cs",
    });

    let tokenCalls = 0;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("oauth-protected-resource")) {
        return new Response(
          JSON.stringify({ resource: "https://api.example/v1" }),
          { status: 200 },
        );
      }
      if (url.includes("oauth-authorization-server")) {
        return new Response(
          JSON.stringify({
            authorization_endpoint: "https://auth.example/authorize",
            token_endpoint: "https://auth.example/token",
            registration_endpoint: "https://auth.example/register",
            resource_servers: [],
          }),
          { status: 200 },
        );
      }
      if (url === "https://auth.example/token") {
        tokenCalls += 1;
        return new Response(
          JSON.stringify({
            access_token: "fresh-bearer",
            token_type: "Bearer",
            expires_in: 3600,
            scope: "sessions:read sessions:write",
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    };

    const out = await resolveAgentToken(config, "@cli.bot");
    assert.equal(out.token, "fresh-bearer");
    assert.equal(tokenCalls, 1);
    // The renewed value is also persisted.
    const row = store.getAgentCredential("global", "@cli.bot");
    assert.equal(row?.bearer, "fresh-bearer");
  });

  it("self-heals when the credential-store key has rotated: purges + emits a clear error", async () => {
    const { AesGcmEncryptor } = await import(
      "../src/credentials/aes-encryptor.js"
    );
    const config = makeConfig({
      name: "global",
      url: "https://api.example/v1",
      authMode: "oauth",
      authBaseUrl: "https://auth.example",
      websocketUrl: "wss://ws.example",
    });

    // Phase 1: write rows under encryptor A.
    const encA = AesGcmEncryptor.fromKey(AesGcmEncryptor.generateKey());
    _setEncryptorForTests(encA);
    const { openProcessCredentialStore } = await import(
      "../src/credentials/lifecycle.js"
    );
    const sA = await openProcessCredentialStore(config);
    sA.putLocalAdminToken("global", "admin-tok");
    sA.putAgentCredential({
      networkName: "global",
      handle: "@cli.bot",
      kind: "local_bearer",
      bearer: "agent-tok",
    });

    // Phase 2: rotate to encryptor B (simulating "credential-store key rotated").
    _setEncryptorForTests(AesGcmEncryptor.fromKey(AesGcmEncryptor.generateKey()));

    await assert.rejects(
      resolveAgentToken(config, "@cli.bot"),
      (err: unknown) =>
        err instanceof RobotNetCLIError &&
        err.message.includes("cannot decrypt") &&
        err.message.includes("credential-store key was likely rotated") &&
        err.message.includes("re-register"),
    );

    // The store should now be clean — both rows gone.
    const sB = await openProcessCredentialStore(config);
    assert.equal(sB.countLocalAdminTokens(), 0);
    assert.equal(sB.countAgentCredentials(), 0);
  });

  it("renews an expired oauth_pkce bearer via the refresh token, rotating the row", async () => {
    const config = makeConfig({
      name: "global",
      url: "https://api.example/v1",
      authMode: "oauth",
      authBaseUrl: "https://auth.example",
      websocketUrl: "wss://ws.example",
    });
    const { openProcessCredentialStore } = await import(
      "../src/credentials/lifecycle.js"
    );
    const store = await openProcessCredentialStore(config);
    store.putAgentCredential({
      networkName: "global",
      handle: "@cli.bot",
      kind: "oauth_pkce",
      bearer: "stale-bearer",
      bearerExpiresAt: Date.now() - 1,
      refreshToken: "rt-old",
      clientId: "public-ci",
      scope: "sessions:read sessions:write",
    });

    let tokenBody = "";
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("oauth-protected-resource")) {
        return new Response(
          JSON.stringify({ resource: "https://api.example/v1" }),
          { status: 200 },
        );
      }
      if (url.includes("oauth-authorization-server")) {
        return new Response(
          JSON.stringify({
            authorization_endpoint: "https://auth.example/authorize",
            token_endpoint: "https://auth.example/token",
            registration_endpoint: "https://auth.example/register",
            resource_servers: [],
          }),
          { status: 200 },
        );
      }
      if (url === "https://auth.example/token") {
        tokenBody = String(init?.body ?? "");
        return new Response(
          JSON.stringify({
            access_token: "fresh-bearer",
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: "rt-new",
            scope: "sessions:read sessions:write",
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    };
    try {
      const out = await resolveAgentToken(config, "@cli.bot");
      assert.deepEqual(out, { token: "fresh-bearer", source: "store" });
      const params = new URLSearchParams(tokenBody);
      assert.equal(params.get("grant_type"), "refresh_token");
      assert.equal(params.get("client_id"), "public-ci");
      assert.equal(params.get("refresh_token"), "rt-old");
      // Row is rotated: new bearer + new refresh token in place.
      const reread = store.getAgentCredential("global", "@cli.bot");
      assert.equal(reread?.bearer, "fresh-bearer");
      assert.equal(reread?.refreshToken, "rt-new");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("serializes concurrent oauth_pkce refreshes and rereads the rotated row", async () => {
    const config = makeConfig({
      name: "global",
      url: "https://api.example/v1",
      authMode: "oauth",
      authBaseUrl: "https://auth.example",
      websocketUrl: "wss://ws.example",
    });
    const { openProcessCredentialStore } = await import(
      "../src/credentials/lifecycle.js"
    );
    const store = await openProcessCredentialStore(config);
    store.putAgentCredential({
      networkName: "global",
      handle: "@cli.bot",
      kind: "oauth_pkce",
      bearer: "stale-bearer",
      bearerExpiresAt: Date.now() - 1,
      refreshToken: "rt-old",
      clientId: "public-ci",
      scope: "sessions:read sessions:write",
    });

    let tokenCalls = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("oauth-protected-resource")) {
        return new Response(
          JSON.stringify({ resource: "https://api.example/v1" }),
          { status: 200 },
        );
      }
      if (url.includes("oauth-authorization-server")) {
        return new Response(
          JSON.stringify({
            authorization_endpoint: "https://auth.example/authorize",
            token_endpoint: "https://auth.example/token",
            registration_endpoint: "https://auth.example/register",
            resource_servers: [],
          }),
          { status: 200 },
        );
      }
      if (url === "https://auth.example/token") {
        tokenCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return new Response(
          JSON.stringify({
            access_token: "fresh-bearer",
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: "rt-new",
            scope: "sessions:read sessions:write",
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    };
    try {
      const [a, b] = await Promise.all([
        resolveAgentToken(config, "@cli.bot"),
        resolveAgentToken(config, "@cli.bot"),
      ]);

      assert.deepEqual(a, { token: "fresh-bearer", source: "store" });
      assert.deepEqual(b, { token: "fresh-bearer", source: "store" });
      assert.equal(tokenCalls, 1);
      const reread = store.getAgentCredential("global", "@cli.bot");
      assert.equal(reread?.bearer, "fresh-bearer");
      assert.equal(reread?.refreshToken, "rt-new");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("clears an oauth_pkce agent credential when refresh is fatally rejected", async () => {
    const config = makeConfig({
      name: "global",
      url: "https://api.example/v1",
      authMode: "oauth",
      authBaseUrl: "https://auth.example",
      websocketUrl: "wss://ws.example",
    });
    const { openProcessCredentialStore } = await import(
      "../src/credentials/lifecycle.js"
    );
    const store = await openProcessCredentialStore(config);
    store.putAgentCredential({
      networkName: "global",
      handle: "@cli.bot",
      kind: "oauth_pkce",
      bearer: "stale-bearer",
      bearerExpiresAt: Date.now() - 1,
      refreshToken: "rt-revoked",
      clientId: "public-ci",
      scope: "sessions:read sessions:write",
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("oauth-protected-resource")) {
        return new Response(
          JSON.stringify({ resource: "https://api.example/v1" }),
          { status: 200 },
        );
      }
      if (url.includes("oauth-authorization-server")) {
        return new Response(
          JSON.stringify({
            authorization_endpoint: "https://auth.example/authorize",
            token_endpoint: "https://auth.example/token",
            registration_endpoint: "https://auth.example/register",
            resource_servers: [],
          }),
          { status: 200 },
        );
      }
      if (url === "https://auth.example/token") {
        return new Response(
          JSON.stringify({
            error: "invalid_grant",
            error_description: "Refresh token family revoked",
          }),
          { status: 400 },
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    };
    try {
      await assert.rejects(
        resolveAgentToken(config, "@cli.bot"),
        (err: unknown) =>
          err instanceof RobotNetCLIError &&
          err.message.includes("stored PKCE refresh token was rejected") &&
          err.message.includes("Cleared the stale credential"),
      );
      assert.equal(store.getAgentCredential("global", "@cli.bot"), null);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("errors helpfully when an expired oauth_pkce row is missing renewal material", async () => {
    const config = makeConfig({
      name: "global",
      url: "https://api.example/v1",
      authMode: "oauth",
      authBaseUrl: "https://auth.example",
      websocketUrl: "wss://ws.example",
    });
    const { openProcessCredentialStore } = await import(
      "../src/credentials/lifecycle.js"
    );
    const store = await openProcessCredentialStore(config);
    // Bypass validation by going under the hood — represents a row that
    // pre-dates the refresh-wiring schema (clientId still null on disk).
    store.putAgentCredential({
      networkName: "global",
      handle: "@cli.bot",
      kind: "oauth_pkce",
      bearer: "stale-bearer",
      bearerExpiresAt: Date.now() - 1,
      refreshToken: "rt",
      clientId: "ci",
    });
    // Manually null out client_id at the SQL layer to simulate a hand-edited
    // row that hits the defensive check in auth-resolver.
    const dbPath = `${config.paths.configDir}/credentials.sqlite`;
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(dbPath);
    raw.prepare(
      "UPDATE agent_credentials SET client_id = NULL WHERE network_name = ? AND handle = ?",
    ).run("global", "@cli.bot");
    raw.close();
    _resetCredentialStoreCacheForTests();

    await assert.rejects(
      resolveAgentToken(config, "@cli.bot"),
      (err: unknown) =>
        err instanceof Error &&
        err.message.includes("PKCE bearer has expired") &&
        /Re-run/i.test(err.message),
    );
  });
});
