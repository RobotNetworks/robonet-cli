import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import {
  tokenResponseFromBody,
  requestClientCredentialsToken,
} from "../src/auth/client-credentials.js";
import { AuthenticationError } from "../src/errors.js";

describe("tokenResponseFromBody", () => {
  it("parses a valid token response", () => {
    const body = {
      access_token: "abc123",
      token_type: "Bearer",
      expires_in: 3600,
      scope: "agents:read",
    };
    const result = tokenResponseFromBody(body, "https://api.example.test");
    assert.equal(result.accessToken, "abc123");
    assert.equal(result.tokenType, "Bearer");
    assert.equal(result.expiresIn, 3600);
    assert.equal(result.scope, "agents:read");
    assert.equal(result.resource, "https://api.example.test");
  });

  it("defaults token_type to Bearer when missing", () => {
    const body = { access_token: "abc123" };
    const result = tokenResponseFromBody(body, "https://api.example.test");
    assert.equal(result.tokenType, "Bearer");
  });

  it("handles null expires_in and scope", () => {
    const body = { access_token: "abc123", token_type: "Bearer" };
    const result = tokenResponseFromBody(body, "https://api.example.test");
    assert.equal(result.expiresIn, null);
    assert.equal(result.scope, null);
  });

  it("throws for missing access_token", () => {
    assert.throws(
      () => tokenResponseFromBody({}, "https://api.example.test"),
      AuthenticationError,
    );
  });

  it("throws for empty access_token", () => {
    assert.throws(
      () =>
        tokenResponseFromBody(
          { access_token: "" },
          "https://api.example.test",
        ),
      AuthenticationError,
    );
  });
});

describe("requestClientCredentialsToken", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends correct form-encoded body", async () => {
    let capturedBody = "";

    globalThis.fetch = async (_input, init) => {
      capturedBody = init!.body as string;
      return new Response(
        JSON.stringify({
          access_token: "tok_123",
          token_type: "Bearer",
          expires_in: 7200,
        }),
        { status: 200 },
      );
    };

    const result = await requestClientCredentialsToken({
      tokenEndpoint: "https://auth.example.test/token",
      clientId: "client-id",
      clientSecret: "client-secret",
      resource: "https://api.example.test",
      scope: "agents:read mailbox:read",
    });

    assert.equal(result.accessToken, "tok_123");
    assert.equal(result.expiresIn, 7200);

    const params = new URLSearchParams(capturedBody);
    assert.equal(params.get("grant_type"), "client_credentials");
    assert.equal(params.get("client_id"), "client-id");
    assert.equal(params.get("client_secret"), "client-secret");
    assert.equal(params.get("resource"), "https://api.example.test");
    assert.equal(params.get("scope"), "agents:read mailbox:read");
  });

  it("throws AuthenticationError on HTTP failure", async () => {
    globalThis.fetch = async () => {
      return new Response(JSON.stringify({ error: "invalid_client" }), {
        status: 401,
      });
    };

    await assert.rejects(
      () =>
        requestClientCredentialsToken({
          tokenEndpoint: "https://auth.example.test/token",
          clientId: "bad",
          clientSecret: "bad",
          resource: "https://api.example.test",
        }),
      AuthenticationError,
    );
  });

  it("throws AuthenticationError on network failure", async () => {
    globalThis.fetch = async () => {
      throw new TypeError("fetch failed");
    };

    await assert.rejects(
      () =>
        requestClientCredentialsToken({
          tokenEndpoint: "https://auth.example.test/token",
          clientId: "id",
          clientSecret: "secret",
          resource: "https://api.example.test",
        }),
      AuthenticationError,
    );
  });
});
