import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";

import { fetchAccountAgents } from "../src/auth/account-agents.js";
import type { CLIConfig } from "../src/config.js";
import { AuthenticationError } from "../src/errors.js";

function makeConfig(): CLIConfig {
  return {
    profile: "default",
    profileSource: { kind: "default" },
    environment: "prod",
    endpoints: {
      apiBaseUrl: "https://api.example/v1",
      authBaseUrl: "https://auth.example",
      websocketUrl: "wss://ws.example",
    },
    paths: {
      configDir: "/tmp/x",
      stateDir: "/tmp/x",
      logsDir: "/tmp/x",
      runDir: "/tmp/x",
    },
    configFile: "/tmp/x/config.json",
    tokenStoreFile: "/tmp/x/auth.json",
    network: {
      name: "robotnet",
      url: "https://api.example/v1",
      authMode: "oauth",
    },
    networkSource: { kind: "default" },
    networks: {
      robotnet: {
        name: "robotnet",
        url: "https://api.example/v1",
        authMode: "oauth",
      },
    },
  };
}

describe("fetchAccountAgents", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("hits /accounts/me/agents with the user bearer", async () => {
    let captured: { url: string; auth: string } | null = null;
    globalThis.fetch = async (input, init) => {
      captured = {
        url: String(input),
        auth: ((init?.headers ?? {}) as Record<string, string>).Authorization ?? "",
      };
      return new Response(
        JSON.stringify({ agents: [{ handle: "@cli.bot" }, { handle: "@migration.bot", name: "Migration" }] }),
        { status: 200 },
      );
    };
    const got = await fetchAccountAgents({
      config: makeConfig(),
      accessToken: "user-tok",
    });
    assert.equal(captured!.url, "https://api.example/v1/accounts/me/agents");
    assert.equal(captured!.auth, "Bearer user-tok");
    assert.deepEqual(got, [
      { handle: "@cli.bot" },
      { handle: "@migration.bot", name: "Migration" },
    ]);
  });

  it("rejects 401/403 with an actionable error", async () => {
    globalThis.fetch = async () => new Response("nope", { status: 401 });
    await assert.rejects(
      fetchAccountAgents({ config: makeConfig(), accessToken: "x" }),
      (err: unknown) =>
        err instanceof AuthenticationError &&
        /Run `robotnet login`/.test(err.message),
    );
  });

  it("rejects malformed responses", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ wrong: "shape" }), { status: 200 });
    await assert.rejects(
      fetchAccountAgents({ config: makeConfig(), accessToken: "x" }),
      (err: unknown) =>
        err instanceof AuthenticationError &&
        /missing "agents" array/.test(err.message),
    );
  });

  it("rejects entries missing handle", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ agents: [{ name: "no handle" }] }), {
        status: 200,
      });
    await assert.rejects(
      fetchAccountAgents({ config: makeConfig(), accessToken: "x" }),
      AuthenticationError,
    );
  });

  it("ignores extra fields the server may add", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          agents: [
            { handle: "@x.y", name: "X", policy: "open", extra: "ignored" },
          ],
        }),
        { status: 200 },
      );
    const got = await fetchAccountAgents({ config: makeConfig(), accessToken: "x" });
    assert.deepEqual(got, [{ handle: "@x.y", name: "X", policy: "open" }]);
  });
});
