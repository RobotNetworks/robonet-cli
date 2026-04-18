import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { isTokenExpired, storedTokenFromClientCredentials } from "../src/auth/token-store.js";

describe("isTokenExpired", () => {
  it("returns false when expiresAt is null", () => {
    const token = storedTokenFromClientCredentials(
      {
        accessToken: "tok",
        tokenType: "Bearer",
        expiresIn: null,
        scope: null,
        resource: "https://api.test",
      },
      "https://auth.test/token",
      "client-id",
    );
    assert.equal(isTokenExpired(token), false);
  });

  it("returns false for a far-future expiry", () => {
    const token = storedTokenFromClientCredentials(
      {
        accessToken: "tok",
        tokenType: "Bearer",
        expiresIn: 3600,
        scope: null,
        resource: "https://api.test",
      },
      "https://auth.test/token",
      "client-id",
    );
    // expiresAt should be ~3600s from now, well in the future
    assert.equal(isTokenExpired(token), false);
  });

  it("returns true when expiresAt is in the past", () => {
    const token = {
      accessToken: "tok",
      tokenType: "Bearer",
      expiresIn: 1,
      expiresAt: Date.now() - 60_000, // 1 minute ago
      scope: null,
      resource: "https://api.test",
      tokenEndpoint: "https://auth.test/token",
      clientId: "client-id",
      authMode: "client_credentials" as const,
      refreshToken: null,
      redirectUri: null,
    };
    assert.equal(isTokenExpired(token), true);
  });

  it("treats token as expired within 30s buffer", () => {
    const token = {
      accessToken: "tok",
      tokenType: "Bearer",
      expiresIn: 1,
      expiresAt: Date.now() + 10_000, // 10s from now, within 30s buffer
      scope: null,
      resource: "https://api.test",
      tokenEndpoint: "https://auth.test/token",
      clientId: "client-id",
      authMode: "client_credentials" as const,
      refreshToken: null,
      redirectUri: null,
    };
    assert.equal(isTokenExpired(token), true);
  });
});
