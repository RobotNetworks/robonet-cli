import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import {
  collectResources,
  discoverOAuth,
  websocketOrApiResource,
  type OAuthDiscovery,
} from "../src/auth/discovery.js";
import { DiscoveryError } from "../src/errors.js";
import type { NetworkConfig } from "../src/config.js";

const NETWORK: NetworkConfig = {
  name: "global",
  url: "https://api.test/v1",
  authMode: "oauth",
  authBaseUrl: "https://auth.test",
  websocketUrl: "wss://ws.test",
};

describe("websocketOrApiResource", () => {
  it("prefers websocket resource", () => {
    const discovery: OAuthDiscovery = {
      authorizationEndpoint: "https://auth.test/authorize",
      tokenEndpoint: "https://auth.test/token",
      registrationEndpoint: "https://auth.test/register",
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
      apiResource: null,
      websocketResource: null,
    };
    assert.throws(() => websocketOrApiResource(discovery), DiscoveryError);
  });
});

describe("collectResources", () => {
  // Regression for the WS-handshake 401 bug: bearers minted with only
  // the API resource fail audience validation against any operator
  // that enforces audience binding on the WebSocket route.
  it("returns BOTH api + websocket resources for agent audience when discovery surfaces both", () => {
    const discovery: OAuthDiscovery = {
      authorizationEndpoint: "https://auth.test/authorize",
      tokenEndpoint: "https://auth.test/token",
      registrationEndpoint: "https://auth.test/register",
      apiResource: "https://api.test/v1",
      websocketResource: "wss://ws.test",
    };
    assert.deepEqual(collectResources(discovery, NETWORK, "agent"), [
      "https://api.test/v1",
      "wss://ws.test",
    ]);
  });

  // Regression for the user-mode "Unsupported resource audience" 400:
  // operators reject the WS resource on user-scoped grants because no
  // agent principal exists.
  it("omits the websocket resource for user audience even when discovery surfaces one", () => {
    const discovery: OAuthDiscovery = {
      authorizationEndpoint: "https://auth.test/authorize",
      tokenEndpoint: "https://auth.test/token",
      registrationEndpoint: "https://auth.test/register",
      apiResource: "https://api.test/v1",
      websocketResource: "wss://ws.test",
    };
    assert.deepEqual(collectResources(discovery, NETWORK, "user"), [
      "https://api.test/v1",
    ]);
  });

  it("dedupes when api + ws resources are identical (agent)", () => {
    const discovery: OAuthDiscovery = {
      authorizationEndpoint: "https://auth.test/authorize",
      tokenEndpoint: "https://auth.test/token",
      registrationEndpoint: "https://auth.test/register",
      apiResource: "https://api.test/v1",
      websocketResource: "https://api.test/v1",
    };
    assert.deepEqual(collectResources(discovery, NETWORK, "agent"), [
      "https://api.test/v1",
    ]);
  });

  it("omits websocket resource when discovery doesn't surface one", () => {
    const discovery: OAuthDiscovery = {
      authorizationEndpoint: "https://auth.test/authorize",
      tokenEndpoint: "https://auth.test/token",
      registrationEndpoint: "https://auth.test/register",
      apiResource: "https://api.test/v1",
      websocketResource: null,
    };
    assert.deepEqual(collectResources(discovery, NETWORK, "agent"), [
      "https://api.test/v1",
    ]);
  });

  it("falls back to network.url when discovery has neither", () => {
    const discovery: OAuthDiscovery = {
      authorizationEndpoint: "https://auth.test/authorize",
      tokenEndpoint: "https://auth.test/token",
      registrationEndpoint: "https://auth.test/register",
      apiResource: null,
      websocketResource: null,
    };
    assert.deepEqual(collectResources(discovery, NETWORK, "agent"), [
      "https://api.test/v1",
    ]);
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
      name: "test",
      url: "https://api.test/v1",
      authMode: "oauth",
      authBaseUrl: "https://auth.test",
      websocketUrl: "wss://ws.test",
    });

    assert.equal(result.authorizationEndpoint, "https://auth.test/authorize");
    assert.equal(result.tokenEndpoint, "https://auth.test/token");
    assert.equal(result.registrationEndpoint, "https://auth.test/register");
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
          name: "test",
          url: "https://api.test/v1",
          authMode: "oauth",
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
          name: "test",
          url: "https://api.test/v1",
          authMode: "oauth",
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
          name: "test",
          url: "https://api.test/v1",
          authMode: "oauth",
          authBaseUrl: "https://auth.test",
          websocketUrl: "wss://ws.test",
        }),
      DiscoveryError,
    );
  });
});
