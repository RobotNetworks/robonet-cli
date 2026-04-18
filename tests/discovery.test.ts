import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import {
  discoverOAuth,
  websocketOrApiResource,
  type OAuthDiscovery,
} from "../src/auth/discovery.js";
import { DiscoveryError } from "../src/errors.js";

describe("websocketOrApiResource", () => {
  it("prefers websocket resource", () => {
    const discovery: OAuthDiscovery = {
      authorizationEndpoint: "https://auth.test/authorize",
      tokenEndpoint: "https://auth.test/token",
      registrationEndpoint: "https://auth.test/register",
      mcpResource: "https://mcp.test",
      apiResource: "https://api.test",
      websocketResource: "wss://ws.test",
    };
    assert.equal(websocketOrApiResource(discovery), "wss://ws.test");
  });

  it("falls back to API resource", () => {
    const discovery: OAuthDiscovery = {
      authorizationEndpoint: "https://auth.test/authorize",
      tokenEndpoint: "https://auth.test/token",
      registrationEndpoint: "https://auth.test/register",
      mcpResource: "https://mcp.test",
      apiResource: "https://api.test",
      websocketResource: null,
    };
    assert.equal(websocketOrApiResource(discovery), "https://api.test");
  });

  it("throws when both are null", () => {
    const discovery: OAuthDiscovery = {
      authorizationEndpoint: "https://auth.test/authorize",
      tokenEndpoint: "https://auth.test/token",
      registrationEndpoint: "https://auth.test/register",
      mcpResource: "https://mcp.test",
      apiResource: null,
      websocketResource: null,
    };
    assert.throws(() => websocketOrApiResource(discovery), DiscoveryError);
  });
});

describe("discoverOAuth", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("parses valid discovery responses", async () => {
    globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("oauth-protected-resource")) {
        return new Response(
          JSON.stringify({ resource: "https://api.test/v1" }),
          { status: 200 },
        );
      }
      if (url.includes("oauth-authorization-server")) {
        return new Response(
          JSON.stringify({
            authorization_endpoint: "https://auth.test/authorize",
            token_endpoint: "https://auth.test/token",
            registration_endpoint: "https://auth.test/register",
            resource_servers: [
              { resource: "https://mcp.test/mcp" },
              { resource: "https://api.test/v1" },
              { resource: "wss://ws.test" },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("", { status: 404 });
    };

    const result = await discoverOAuth({
      apiBaseUrl: "https://api.test/v1",
      mcpBaseUrl: "https://mcp.test/mcp",
      authBaseUrl: "https://auth.test",
      websocketUrl: "wss://ws.test",
    });

    assert.equal(result.authorizationEndpoint, "https://auth.test/authorize");
    assert.equal(result.tokenEndpoint, "https://auth.test/token");
    assert.equal(result.registrationEndpoint, "https://auth.test/register");
    assert.equal(result.mcpResource, "https://mcp.test/mcp");
    assert.equal(result.apiResource, "https://api.test/v1");
    assert.equal(result.websocketResource, "wss://ws.test");
  });

  it("throws on non-200 API protected resource response", async () => {
    globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("oauth-protected-resource")) {
        return new Response("", { status: 404 });
      }
      return new Response("{}", { status: 200 });
    };

    await assert.rejects(
      () =>
        discoverOAuth({
          apiBaseUrl: "https://api.test/v1",
          mcpBaseUrl: "https://mcp.test/mcp",
          authBaseUrl: "https://auth.test",
          websocketUrl: "wss://ws.test",
        }),
      DiscoveryError,
    );
  });

  it("throws when authorization_endpoint is missing", async () => {
    globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("oauth-protected-resource")) {
        return new Response(
          JSON.stringify({ resource: "https://api.test/v1" }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          token_endpoint: "https://auth.test/token",
          registration_endpoint: "https://auth.test/register",
        }),
        { status: 200 },
      );
    };

    await assert.rejects(
      () =>
        discoverOAuth({
          apiBaseUrl: "https://api.test/v1",
          mcpBaseUrl: "https://mcp.test/mcp",
          authBaseUrl: "https://auth.test",
          websocketUrl: "wss://ws.test",
        }),
      DiscoveryError,
    );
  });

  it("throws on network failure", async () => {
    globalThis.fetch = async () => {
      throw new TypeError("fetch failed");
    };

    await assert.rejects(
      () =>
        discoverOAuth({
          apiBaseUrl: "https://api.test/v1",
          mcpBaseUrl: "https://mcp.test/mcp",
          authBaseUrl: "https://auth.test",
          websocketUrl: "wss://ws.test",
        }),
      DiscoveryError,
    );
  });
});
