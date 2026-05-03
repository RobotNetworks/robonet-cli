import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";

import { AspAdminClient } from "../src/asp/admin-client.js";
import { AspApiError, AspNetworkUnreachableError } from "../src/asp/errors.js";
import { USER_AGENT } from "../src/version.js";

interface CapturedCall {
  readonly url: string;
  readonly init: RequestInit;
}

function withFetchMock(
  responses: Array<(call: CapturedCall) => Response | Promise<Response>>,
): { readonly calls: readonly CapturedCall[] } {
  const calls: CapturedCall[] = [];
  let i = 0;
  globalThis.fetch = async (input, init) => {
    const call: CapturedCall = { url: String(input), init: init ?? {} };
    calls.push(call);
    if (i >= responses.length) {
      throw new Error(`unexpected extra fetch call to ${call.url}`);
    }
    return responses[i++](call);
  };
  return { calls };
}

describe("AspAdminClient", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("registerAgent issues POST /_admin/agents with bearer auth and User-Agent", async () => {
    const { calls } = withFetchMock([
      () =>
        new Response(
          JSON.stringify({
            handle: "@cli.bot",
            token: "tok-1",
            policy: "allowlist",
            allowlist: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    ]);

    const client = new AspAdminClient("http://127.0.0.1:8723", "admin-tok");
    const agent = await client.registerAgent("@cli.bot");

    assert.deepEqual(agent, {
      handle: "@cli.bot",
      token: "tok-1",
      policy: "allowlist",
      allowlist: [],
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://127.0.0.1:8723/_admin/agents");
    assert.equal(calls[0].init.method, "POST");
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer admin-tok");
    assert.equal(headers["User-Agent"], USER_AGENT);
    assert.equal(headers["Content-Type"], "application/json");
    assert.equal(calls[0].init.body, JSON.stringify({ handle: "@cli.bot" }));
  });

  it("registerAgent forwards an explicit policy in the body", async () => {
    const { calls } = withFetchMock([
      () =>
        new Response(
          JSON.stringify({
            handle: "@cli.bot",
            token: "tok-1",
            policy: "open",
            allowlist: [],
          }),
          { status: 200 },
        ),
    ]);

    const client = new AspAdminClient("http://127.0.0.1:8723", "admin-tok");
    await client.registerAgent("@cli.bot", { policy: "open" });

    assert.equal(
      calls[0].init.body,
      JSON.stringify({ handle: "@cli.bot", policy: "open" }),
    );
  });

  it("encodes handles with reserved characters in the URL path", async () => {
    const { calls } = withFetchMock([
      () => new Response(null, { status: 204 }),
    ]);

    const client = new AspAdminClient("http://127.0.0.1:8723", "tok");
    await client.removeAgent("@odd/handle");

    assert.equal(
      calls[0].url,
      `http://127.0.0.1:8723/_admin/agents/${encodeURIComponent("@odd/handle")}`,
    );
    assert.equal(calls[0].init.method, "DELETE");
  });

  it("addToAllowlist POSTs entries to the right path", async () => {
    const { calls } = withFetchMock([
      () =>
        new Response(
          JSON.stringify({
            handle: "@cli.bot",
            token: "tok",
            policy: "allowlist",
            allowlist: ["@migration.bot"],
          }),
          { status: 200 },
        ),
    ]);

    const client = new AspAdminClient("http://127.0.0.1:8723", "admin");
    const out = await client.addToAllowlist("@cli.bot", ["@migration.bot"]);

    assert.deepEqual(out.allowlist, ["@migration.bot"]);
    assert.equal(
      calls[0].url,
      "http://127.0.0.1:8723/_admin/agents/%40cli.bot/allowlist",
    );
    assert.equal(calls[0].init.method, "POST");
    assert.equal(
      calls[0].init.body,
      JSON.stringify({ entries: ["@migration.bot"] }),
    );
  });

  it("translates non-2xx with JSON `error` body into AspApiError carrying the code", async () => {
    withFetchMock([
      () =>
        new Response(JSON.stringify({ error: "agent_already_exists" }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        }),
    ]);

    const client = new AspAdminClient("http://127.0.0.1:8723", "admin");
    await assert.rejects(
      () => client.registerAgent("@cli.bot"),
      (err: unknown) => {
        assert.ok(err instanceof AspApiError);
        assert.equal(err.status, 409);
        assert.equal(err.code, "agent_already_exists");
        return true;
      },
    );
  });

  it("falls back to http_<status> when the error body has no `error` field", async () => {
    withFetchMock([
      () => new Response("not json", { status: 502 }),
    ]);

    const client = new AspAdminClient("http://127.0.0.1:8723", "admin");
    await assert.rejects(
      () => client.showAgent("@cli.bot"),
      (err: unknown) => {
        assert.ok(err instanceof AspApiError);
        assert.equal(err.status, 502);
        assert.equal(err.code, "http_502");
        return true;
      },
    );
  });

  it("translates fetch failure into AspNetworkUnreachableError", async () => {
    globalThis.fetch = async () => {
      throw new TypeError("fetch failed");
    };

    const client = new AspAdminClient("http://127.0.0.1:8723", "admin");
    await assert.rejects(
      () => client.showAgent("@cli.bot"),
      (err: unknown) => {
        assert.ok(err instanceof AspNetworkUnreachableError);
        assert.equal(err.url, "http://127.0.0.1:8723");
        assert.match(err.message, /fetch failed/);
        return true;
      },
    );
  });

  it("returns null-ish from 204 responses (e.g. removeAgent)", async () => {
    withFetchMock([() => new Response(null, { status: 204 })]);

    const client = new AspAdminClient("http://127.0.0.1:8723", "admin");
    await client.removeAgent("@cli.bot");
  });

  it("setPolicy issues PATCH /_admin/agents/<handle> with policy body", async () => {
    const { calls } = withFetchMock([
      () =>
        new Response(
          JSON.stringify({
            handle: "@cli.bot",
            token: "tok",
            policy: "open",
            allowlist: [],
          }),
          { status: 200 },
        ),
    ]);

    const client = new AspAdminClient("http://127.0.0.1:8723", "admin");
    await client.setPolicy("@cli.bot", "open");

    assert.equal(calls[0].init.method, "PATCH");
    assert.equal(
      calls[0].url,
      "http://127.0.0.1:8723/_admin/agents/%40cli.bot",
    );
    assert.equal(calls[0].init.body, JSON.stringify({ policy: "open" }));
  });
});
