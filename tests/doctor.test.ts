import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import { loadConfig } from "../src/config.js";
import { runDoctor } from "../src/doctor.js";
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

describe("runDoctor", () => {
  it("reports stored auth when token file exists", async () => {
    const config = loadConfig();

    // Write a valid token file
    fs.mkdirSync(config.paths.configDir, { recursive: true });
    fs.writeFileSync(
      config.tokenStoreFile,
      JSON.stringify({
        access_token: "token",
        token_type: "Bearer",
        resource: "https://api.example.test/v1",
        token_endpoint: "https://auth.example.test/token",
        client_id: "client_123",
      }),
      "utf-8",
    );

    // Mock fetch for endpoint and discovery checks
    globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/agents/me")) {
        return new Response("Unauthorized", { status: 401 });
      }
      if (url.includes("oauth-protected-resource")) {
        return new Response(
          JSON.stringify({
            resource: "https://api.example.test/v1",
          }),
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
      return new Response("Not Found", { status: 404 });
    };

    const checks = await runDoctor(config);
    const byName = Object.fromEntries(checks.map((c) => [c.name, c]));

    assert.equal(byName.endpoint_api.ok, true);
    assert.equal(byName.oauth_discovery.ok, true);
    assert.equal(byName.stored_auth.ok, true);
  });

  it("reports missing stored auth", async () => {
    const config = loadConfig();

    globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/agents/me")) {
        return new Response("Unauthorized", { status: 401 });
      }
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
      return new Response("Not Found", { status: 404 });
    };

    const checks = await runDoctor(config);
    const byName = Object.fromEntries(checks.map((c) => [c.name, c]));

    assert.equal(byName.stored_auth.ok, false);
  });
});
