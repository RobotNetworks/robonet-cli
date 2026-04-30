import { afterEach, beforeEach, describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  resolveApiBearerToken,
  resolveRuntimeSession,
} from "../src/auth/runtime.js";
import {
  loadToken,
  saveToken,
  storedTokenFromPkceLogin,
} from "../src/auth/token-store.js";
import {
  AuthenticationError,
  FatalAuthError,
  TransientAuthError,
} from "../src/errors.js";

const ENDPOINTS = {
  apiBaseUrl: "https://api.example.test/v1",
  authBaseUrl: "https://auth.example.test",
  websocketUrl: "wss://ws.example.test/socket",
} as const;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "runtime-test-"));
}

function writePkceToken(filePath: string): void {
  const stored = storedTokenFromPkceLogin({
    token: {
      accessToken: "stored-access-token",
      tokenType: "Bearer",
      expiresIn: 3600,
      scope: "threads:read",
      resource: "https://api.example.test/v1",
    },
    tokenEndpoint: "https://auth.example.test/token",
    clientId: "public_client",
    refreshToken: "stored-refresh-token",
    redirectUri: "http://127.0.0.1:8788/callback",
  });
  saveToken(filePath, stored);
}

describe("runtime auth", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("resolveApiBearerToken reuses a stored PKCE access token until expiry", async () => {
    const dir = tmpDir();
    const tokenStorePath = path.join(dir, "auth.json");
    writePkceToken(tokenStorePath);

    const seenUrls: string[] = [];
    globalThis.fetch = async (input) => {
      const url = input as string;
      seenUrls.push(url);
      throw new Error(`Unexpected fetch: ${url}`);
    };

    const token = await resolveApiBearerToken({
      endpoints: ENDPOINTS,
      tokenStorePath,
      clientId: null,
      clientSecret: null,
    });

    assert.equal(token.accessToken, "stored-access-token");
    assert.deepEqual(seenUrls, []);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("resolveApiBearerToken ignores discovery failures when a stored PKCE token is still valid", async () => {
    const dir = tmpDir();
    const tokenStorePath = path.join(dir, "auth.json");
    writePkceToken(tokenStorePath);

    globalThis.fetch = async () => {
      throw new Error("discovery unavailable");
    };

    const token = await resolveApiBearerToken({
      endpoints: ENDPOINTS,
      tokenStorePath,
      clientId: null,
      clientSecret: null,
    });

    assert.equal(token.accessToken, "stored-access-token");

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("resolveApiBearerToken refreshes an expired PKCE access token", async () => {
    const dir = tmpDir();
    const tokenStorePath = path.join(dir, "auth.json");
    writePkceToken(tokenStorePath);
    const stored = loadToken(tokenStorePath);
    assert.ok(stored);
    saveToken(tokenStorePath, {
      ...stored,
      expiresAt: Date.now() - 1_000,
    });

    const seenUrls: string[] = [];
    globalThis.fetch = async (input, init) => {
      const url = input as string;
      seenUrls.push(url);
      if (url.endsWith("/.well-known/oauth-protected-resource")) {
        return Response.json({ resource: "https://api.example.test/v1" });
      }
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return Response.json({
          authorization_endpoint: "https://auth.example.test/authorize",
          token_endpoint: "https://auth.example.test/token",
          registration_endpoint: "https://auth.example.test/register",
          resource_servers: [
            { resource: "https://api.example.test/v1" },
            { resource: "wss://ws.example.test/socket" },
          ],
        });
      }
      if (url === "https://auth.example.test/token") {
        const body = String(init?.body);
        assert.match(body, /grant_type=refresh_token/);
        assert.match(body, /resource=https%3A%2F%2Fapi\.example\.test%2Fv1/);
        return Response.json({
          access_token: "refreshed-access-token",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "refreshed-refresh-token",
          scope: "threads:read",
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    const token = await resolveApiBearerToken({
      endpoints: ENDPOINTS,
      tokenStorePath,
      clientId: null,
      clientSecret: null,
    });

    assert.equal(token.accessToken, "refreshed-access-token");
    const saved = loadToken(tokenStorePath);
    assert.ok(saved);
    assert.equal(saved.accessToken, "refreshed-access-token");
    assert.equal(saved.refreshToken, "refreshed-refresh-token");
    assert.equal(seenUrls.at(-1), "https://auth.example.test/token");

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("resolveRuntimeSession keeps a valid stored API token and only refreshes websocket auth", async () => {
    const dir = tmpDir();
    const tokenStorePath = path.join(dir, "auth.json");
    writePkceToken(tokenStorePath);

    const seenUrls: string[] = [];
    globalThis.fetch = async (input, init) => {
      const url = input as string;
      seenUrls.push(url);
      if (url.endsWith("/.well-known/oauth-protected-resource")) {
        return Response.json({ resource: "https://api.example.test/v1" });
      }
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return Response.json({
          authorization_endpoint: "https://auth.example.test/authorize",
          token_endpoint: "https://auth.example.test/token",
          registration_endpoint: "https://auth.example.test/register",
          resource_servers: [
            { resource: "https://api.example.test/v1" },
            { resource: "wss://ws.example.test/socket" },
          ],
        });
      }
      if (url === "https://auth.example.test/token") {
        const body = String(init?.body);
        assert.match(body, /resource=wss%3A%2F%2Fws\.example\.test%2Fsocket/);
        return Response.json({
          access_token: "websocket-access-token",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "rotated-refresh-token",
          scope: "threads:read",
        });
      }
      if (url === "https://api.example.test/v1/agents/me") {
        const headers = new Headers(init?.headers);
        assert.equal(
          headers.get("Authorization"),
          "Bearer stored-access-token",
        );
        return Response.json({
          owner: "acme",
          name: "helper",
          display_name: "Helper",
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    const session = await resolveRuntimeSession({
      endpoints: ENDPOINTS,
      tokenStorePath,
      clientId: null,
      clientSecret: null,
    });

    assert.equal(session.apiToken.accessToken, "stored-access-token");
    assert.equal(session.websocketToken.accessToken, "websocket-access-token");
    const saved = loadToken(tokenStorePath);
    assert.ok(saved);
    assert.equal(saved.accessToken, "stored-access-token");
    assert.equal(saved.refreshToken, "rotated-refresh-token");
    assert.equal(
      seenUrls.filter((url) => url === "https://auth.example.test/token").length,
      1,
    );

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("resolveApiBearerToken throws FatalAuthError and clears the stored token on a 4xx refresh failure", async () => {
    const dir = tmpDir();
    const tokenStorePath = path.join(dir, "auth.json");
    writePkceToken(tokenStorePath);
    const stored = loadToken(tokenStorePath);
    assert.ok(stored);
    saveToken(tokenStorePath, { ...stored, expiresAt: Date.now() - 1_000 });

    globalThis.fetch = async (input) => {
      const url = input as string;
      if (url.endsWith("/.well-known/oauth-protected-resource")) {
        return Response.json({ resource: "https://api.example.test/v1" });
      }
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return Response.json({
          authorization_endpoint: "https://auth.example.test/authorize",
          token_endpoint: "https://auth.example.test/token",
          registration_endpoint: "https://auth.example.test/register",
          resource_servers: [{ resource: "https://api.example.test/v1" }],
        });
      }
      if (url === "https://auth.example.test/token") {
        return Response.json(
          {
            error: "invalid_grant",
            error_description: "Refresh token family revoked",
          },
          { status: 401 },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    await assert.rejects(
      resolveApiBearerToken({
        endpoints: ENDPOINTS,
        tokenStorePath,
        clientId: null,
        clientSecret: null,
      }),
      (err: unknown) => {
        assert.ok(err instanceof FatalAuthError);
        assert.match(err.message, /Refresh token family revoked/);
        assert.match(err.message, /robotnet login/);
        return true;
      },
    );

    assert.equal(fs.existsSync(tokenStorePath), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("resolveApiBearerToken throws TransientAuthError and keeps the stored token on a 5xx refresh failure", async () => {
    const dir = tmpDir();
    const tokenStorePath = path.join(dir, "auth.json");
    writePkceToken(tokenStorePath);
    const stored = loadToken(tokenStorePath);
    assert.ok(stored);
    saveToken(tokenStorePath, { ...stored, expiresAt: Date.now() - 1_000 });

    globalThis.fetch = async (input) => {
      const url = input as string;
      if (url.endsWith("/.well-known/oauth-protected-resource")) {
        return Response.json({ resource: "https://api.example.test/v1" });
      }
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return Response.json({
          authorization_endpoint: "https://auth.example.test/authorize",
          token_endpoint: "https://auth.example.test/token",
          registration_endpoint: "https://auth.example.test/register",
          resource_servers: [{ resource: "https://api.example.test/v1" }],
        });
      }
      if (url === "https://auth.example.test/token") {
        return new Response("upstream timeout", { status: 503 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    await assert.rejects(
      resolveApiBearerToken({
        endpoints: ENDPOINTS,
        tokenStorePath,
        clientId: null,
        clientSecret: null,
      }),
      (err: unknown) => {
        assert.ok(err instanceof TransientAuthError);
        assert.ok(!(err instanceof AuthenticationError));
        return true;
      },
    );

    assert.equal(fs.existsSync(tokenStorePath), true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("resolveApiBearerToken treats a 429 from refresh as transient and keeps the stored token", async () => {
    // 429 (rate limit) must NOT delete the stored token — the CLI should
    // back off and retry rather than force the user to re-login.
    const dir = tmpDir();
    const tokenStorePath = path.join(dir, "auth.json");
    writePkceToken(tokenStorePath);
    const stored = loadToken(tokenStorePath);
    assert.ok(stored);
    saveToken(tokenStorePath, { ...stored, expiresAt: Date.now() - 1_000 });

    globalThis.fetch = async (input) => {
      const url = input as string;
      if (url.endsWith("/.well-known/oauth-protected-resource")) {
        return Response.json({ resource: "https://api.example.test/v1" });
      }
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return Response.json({
          authorization_endpoint: "https://auth.example.test/authorize",
          token_endpoint: "https://auth.example.test/token",
          registration_endpoint: "https://auth.example.test/register",
          resource_servers: [{ resource: "https://api.example.test/v1" }],
        });
      }
      if (url === "https://auth.example.test/token") {
        return new Response("rate limited", { status: 429 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    await assert.rejects(
      resolveApiBearerToken({
        endpoints: ENDPOINTS,
        tokenStorePath,
        clientId: null,
        clientSecret: null,
      }),
      (err: unknown) => err instanceof TransientAuthError,
    );

    assert.equal(fs.existsSync(tokenStorePath), true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
