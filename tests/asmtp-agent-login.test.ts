import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  _canonicalizeHandleForTests,
  _persistAgentPkceForTests,
  bearerStillValid,
  enrollAgentClientCredentials,
  renewAgentClientCredentials,
} from "../src/asmtp/agent-login.js";
import type { PKCELoginResult } from "../src/auth/pkce.js";
import type { CLIConfig, NetworkConfig } from "../src/config.js";
import { UnsafePlaintextEncryptor } from "../src/credentials/crypto.js";
import {
  _resetCredentialStoreCacheForTests,
  _setEncryptorForTests,
  openProcessCredentialStore,
} from "../src/credentials/lifecycle.js";

let stateDir: string;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "robotnet-agent-login-test-"));
  originalFetch = globalThis.fetch;
  _setEncryptorForTests(new UnsafePlaintextEncryptor());
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  _setEncryptorForTests(null);
  _resetCredentialStoreCacheForTests();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function makeConfig(network: NetworkConfig = {
  name: "global",
  url: "https://api.example/v1",
  authMode: "oauth",
  authBaseUrl: "https://auth.example",
  websocketUrl: "wss://ws.example",
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

/** Mock fetch to route OAuth discovery + token endpoints to canned responses. */
function mockOAuthFetch(opts: {
  readonly tokenEndpoint?: string;
  readonly tokenResponse?: Record<string, unknown>;
  readonly tokenStatus?: number;
  readonly capturedTokenBody?: { value: string };
}): void {
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
          token_endpoint: opts.tokenEndpoint ?? "https://auth.example/token",
          registration_endpoint: "https://auth.example/register",
          resource_servers: [],
        }),
        { status: 200 },
      );
    }
    if (url === (opts.tokenEndpoint ?? "https://auth.example/token")) {
      if (opts.capturedTokenBody) {
        opts.capturedTokenBody.value = String(init?.body ?? "");
      }
      return new Response(
        JSON.stringify(
          opts.tokenResponse ?? {
            access_token: "minted-bearer",
            token_type: "Bearer",
            expires_in: 3600,
            scope: "agents:read sessions:read sessions:write",
          },
        ),
        { status: opts.tokenStatus ?? 200 },
      );
    }
    return new Response("not found", { status: 404 });
  };
}

describe("bearerStillValid", () => {
  it("treats null expiry as always valid", () => {
    assert.equal(bearerStillValid(null), true);
  });

  it("returns false when expiry is within the grace window", () => {
    assert.equal(bearerStillValid(Date.now() + 5_000), false);
  });

  it("returns true when expiry is comfortably beyond the grace window", () => {
    assert.equal(bearerStillValid(Date.now() + 60_000), true);
  });
});

describe("enrollAgentClientCredentials", () => {
  it("runs the grant and persists an oauth_client_credentials row", async () => {
    const captured = { value: "" };
    mockOAuthFetch({ capturedTokenBody: captured });

    const config = makeConfig();
    const minted = await enrollAgentClientCredentials({
      config,
      handle: "@cli.bot",
      clientId: "ci-xxx",
      clientSecret: "cs-xxx",
      scope: "sessions:read sessions:write",
    });

    assert.equal(minted.bearer, "minted-bearer");
    assert.ok(minted.bearerExpiresAt !== null);
    // Token request body should be form-encoded with the right grant.
    assert.match(captured.value, /grant_type=client_credentials/);
    assert.match(captured.value, /client_id=ci-xxx/);
    assert.match(captured.value, /client_secret=cs-xxx/);
    assert.match(captured.value, /scope=sessions/);

    // Row landed in the store with the renewal material.
    const store = await openProcessCredentialStore(config);
    const row = store.getAgentCredential("global", "@cli.bot");
    assert.ok(row);
    assert.equal(row!.kind, "oauth_client_credentials");
    assert.equal(row!.bearer, "minted-bearer");
    assert.equal(row!.clientId, "ci-xxx");
    assert.equal(row!.clientSecret, "cs-xxx");
    assert.equal(row!.scope, "agents:read sessions:read sessions:write");
  });

  it("propagates an AuthenticationError when the token endpoint rejects", async () => {
    mockOAuthFetch({
      tokenStatus: 401,
      tokenResponse: { error: "invalid_client" },
    });
    await assert.rejects(
      enrollAgentClientCredentials({
        config: makeConfig(),
        handle: "@cli.bot",
        clientId: "bad",
        clientSecret: "bad",
      }),
      (err: unknown) =>
        err instanceof Error && err.message.includes("Token request failed (401)"),
    );
  });
});

describe("_canonicalizeHandleForTests", () => {
  it("prepends @ when missing", () => {
    assert.equal(_canonicalizeHandleForTests("owner.agent"), "@owner.agent");
  });

  it("leaves already-canonical handles alone", () => {
    assert.equal(_canonicalizeHandleForTests("@owner.agent"), "@owner.agent");
  });

  it("rejects malformed input rather than silently passing through", () => {
    assert.throws(() => _canonicalizeHandleForTests("@no-dot"));
    assert.throws(() => _canonicalizeHandleForTests("UPPER.case"));
  });
});

function fakePkceResult(overrides: Partial<PKCELoginResult> = {}): PKCELoginResult {
  return {
    token: {
      accessToken: "minted-bearer",
      expiresIn: 3600,
      scope: "agents:read sessions:read sessions:write",
      tokenType: "Bearer",
      resource: "https://api.example/v1",
    },
    refreshToken: "rt-fake",
    clientId: "oac_fake",
    redirectUri: "http://127.0.0.1:50000/callback",
    tokenEndpoint: "https://auth.example/token",
    agentHandle: "owner.agent",
    network: null,
    ...overrides,
  };
}

describe("persistAgentPkce", () => {
  it("stores the handle in canonical @-prefixed form", async () => {
    const config = makeConfig();
    const enrolled = await _persistAgentPkceForTests({
      config,
      handle: "@owner.agent",
      result: fakePkceResult(),
    });
    assert.equal(enrolled.handle, "@owner.agent");

    // The bug we're guarding against: the row used to land as
    // the bare handle (no @), so listener lookups for the canonical handle missed.
    const store = await openProcessCredentialStore(config);
    const row = store.getAgentCredential("global", "@owner.agent");
    assert.ok(row, "row must be keyed by canonical @-form");
    assert.equal(row!.handle, "@owner.agent");
    assert.equal(row!.kind, "oauth_pkce");
    assert.equal(row!.networkName, "global");
  });

  it("refuses to store when auth-server network disagrees with local config", async () => {
    const config = makeConfig({
      name: "global",
      url: "https://api.example/v1",
      authMode: "oauth",
    });
    await assert.rejects(
      _persistAgentPkceForTests({
        config,
        handle: "@owner.agent",
        // Auth server identifies as a different network than the one
        // the CLI thinks it's logging into → this is exactly the case
        // where the credential would land under the wrong key.
        result: fakePkceResult({ network: "staging" }),
      }),
      (err: unknown) =>
        err instanceof Error &&
        err.message.includes('identifies as network "staging"') &&
        err.message.includes('on network "global"'),
    );

    // Nothing should have been written.
    const store = await openProcessCredentialStore(config);
    assert.equal(store.getAgentCredential("global", "@owner.agent"), null);
  });

  it("falls back to local config when auth-server omits the network field", async () => {
    const config = makeConfig();
    await _persistAgentPkceForTests({
      config,
      handle: "@owner.agent",
      result: fakePkceResult({ network: null }),
    });
    const store = await openProcessCredentialStore(config);
    assert.ok(store.getAgentCredential("global", "@owner.agent"));
  });

  it("accepts when auth-server network matches local config", async () => {
    const config = makeConfig();
    await _persistAgentPkceForTests({
      config,
      handle: "@owner.agent",
      result: fakePkceResult({ network: "global" }),
    });
    const store = await openProcessCredentialStore(config);
    assert.ok(store.getAgentCredential("global", "@owner.agent"));
  });
});

describe("renewAgentClientCredentials", () => {
  it("re-runs the grant and overwrites the row's bearer / expiry", async () => {
    // First mint an initial row.
    mockOAuthFetch({
      tokenResponse: {
        access_token: "first-bearer",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "sessions:read",
      },
    });
    const config = makeConfig();
    await enrollAgentClientCredentials({
      config,
      handle: "@cli.bot",
      clientId: "ci-xxx",
      clientSecret: "cs-xxx",
    });

    // Renewal mints a new bearer.
    mockOAuthFetch({
      tokenResponse: {
        access_token: "second-bearer",
        token_type: "Bearer",
        expires_in: 7200,
        scope: "sessions:read sessions:write",
      },
    });
    const fresh = await renewAgentClientCredentials({
      config,
      handle: "@cli.bot",
      clientId: "ci-xxx",
      clientSecret: "cs-xxx",
      scope: "sessions:read sessions:write",
    });
    assert.equal(fresh, "second-bearer");

    const store = await openProcessCredentialStore(config);
    const row = store.getAgentCredential("global", "@cli.bot");
    assert.ok(row);
    assert.equal(row!.bearer, "second-bearer");
    assert.equal(row!.scope, "sessions:read sessions:write");
    // Expiry should be ~7200s out, not the initial 3600s.
    const remaining = (row!.bearerExpiresAt ?? 0) - Date.now();
    assert.ok(remaining > 3600 * 1000, "expiry advanced past the original");
  });
});
