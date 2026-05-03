import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { TokenResponse } from "../src/auth/client-credentials.js";
import {
  saveToken,
  loadToken,
  storedTokenFromClientCredentials,
  storedTokenFromPkceLogin,
} from "../src/auth/token-store.js";

function sampleToken(
  resource: string = "https://api.example.test/v1",
): TokenResponse {
  return {
    accessToken: "access-token",
    tokenType: "Bearer",
    expiresIn: 3600,
    scope: "sessions:read",
    resource,
  };
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "token-store-test-"));
}

describe("storedTokenFromClientCredentials", () => {
  it("defaults to client_credentials auth mode", () => {
    const stored = storedTokenFromClientCredentials(
      sampleToken(),
      "https://auth.example.test/token",
      "client_123",
    );

    assert.equal(stored.authMode, "client_credentials");
    assert.equal(stored.clientId, "client_123");
    assert.equal(stored.resource, "https://api.example.test/v1");
  });
});

describe("storedTokenFromPkceLogin", () => {
  it("sets refresh metadata", () => {
    const stored = storedTokenFromPkceLogin({
      token: sampleToken(),
      tokenEndpoint: "https://auth.example.test/token",
      clientId: "public_client",
      refreshToken: "refresh-token",
      redirectUri: "http://127.0.0.1:8788/callback",
    });

    assert.equal(stored.authMode, "pkce");
    assert.equal(stored.refreshToken, "refresh-token");
    assert.equal(stored.redirectUri, "http://127.0.0.1:8788/callback");
  });
});

describe("saveToken / loadToken", () => {
  it("round-trips correctly", () => {
    const dir = tmpDir();
    const filePath = path.join(dir, "auth.json");
    const stored = storedTokenFromPkceLogin({
      token: sampleToken(),
      tokenEndpoint: "https://auth.example.test/token",
      clientId: "public_client",
      refreshToken: "refresh-token",
      redirectUri: "http://127.0.0.1:8788/callback",
    });

    saveToken(filePath, stored);
    const loaded = loadToken(filePath);

    assert.deepEqual(loaded, stored);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when file missing", () => {
    assert.equal(loadToken("/tmp/nonexistent-auth-file.json"), null);
  });

  it("returns null for invalid payload", () => {
    const dir = tmpDir();
    const filePath = path.join(dir, "auth.json");
    fs.writeFileSync(filePath, JSON.stringify({ access_token: "" }), "utf-8");

    assert.equal(loadToken(filePath), null);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
