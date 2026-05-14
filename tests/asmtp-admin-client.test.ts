import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";

import { AdminClient } from "../src/asmtp/admin-client.js";
import {
  AsmtpApiError,
  AsmtpNetworkUnreachableError,
} from "../src/asmtp/errors.js";
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

describe("AdminClient", () => {
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

    const client = new AdminClient("http://127.0.0.1:8723", "admin-tok");
    const agent = await client.registerAgent("@cli.bot");

    // The client normalizes the wire response, filling in defaults for the
    // v3-schema fields (display_name, description, card_body, visibility)
    // when an older operator omits them.
    assert.deepEqual(agent, {
      handle: "@cli.bot",
      token: "tok-1",
      policy: "allowlist",
      allowlist: [],
      display_name: "@cli.bot",
      description: null,
      card_body: null,
      visibility: "private",
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

    const client = new AdminClient("http://127.0.0.1:8723", "admin-tok");
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

    const client = new AdminClient("http://127.0.0.1:8723", "tok");
    await client.removeAgent("@odd/handle");

    assert.equal(
      calls[0].url,
      `http://127.0.0.1:8723/_admin/agents/${encodeURIComponent("@odd/handle")}`,
    );
    assert.equal(calls[0].init.method, "DELETE");
  });

  it("listAgents GETs /_admin/agents and returns the agents array", async () => {
    const { calls } = withFetchMock([
      () =>
        new Response(
          JSON.stringify({
            agents: [
              { handle: "@cli.bot", policy: "allowlist", allowlist: [] },
              { handle: "@noisy.bot", policy: "open", allowlist: [] },
            ],
          }),
          { status: 200 },
        ),
    ]);

    const client = new AdminClient("http://127.0.0.1:8723", "admin");
    const agents = await client.listAgents();

    assert.equal(agents.length, 2);
    assert.equal(agents[0].handle, "@cli.bot");
    assert.equal(calls[0].url, "http://127.0.0.1:8723/_admin/agents");
    assert.equal(calls[0].init.method, "GET");
  });

  it("translates non-2xx with JSON `error` body into AsmtpApiError carrying the code", async () => {
    withFetchMock([
      () =>
        new Response(JSON.stringify({ error: "agent_already_exists" }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        }),
    ]);

    const client = new AdminClient("http://127.0.0.1:8723", "admin");
    await assert.rejects(
      () => client.registerAgent("@cli.bot"),
      (err: unknown) => {
        assert.ok(err instanceof AsmtpApiError);
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

    const client = new AdminClient("http://127.0.0.1:8723", "admin");
    await assert.rejects(
      () => client.showAgent("@cli.bot"),
      (err: unknown) => {
        assert.ok(err instanceof AsmtpApiError);
        assert.equal(err.status, 502);
        assert.equal(err.code, "http_502");
        return true;
      },
    );
  });

  it("translates fetch failure into AsmtpNetworkUnreachableError", async () => {
    globalThis.fetch = async () => {
      throw new TypeError("fetch failed");
    };

    const client = new AdminClient("http://127.0.0.1:8723", "admin");
    await assert.rejects(
      () => client.showAgent("@cli.bot"),
      (err: unknown) => {
        assert.ok(err instanceof AsmtpNetworkUnreachableError);
        assert.equal(err.url, "http://127.0.0.1:8723");
        assert.match(err.message, /fetch failed/);
        return true;
      },
    );
  });

  it("returns null-ish from 204 responses (e.g. removeAgent)", async () => {
    withFetchMock([() => new Response(null, { status: 204 })]);

    const client = new AdminClient("http://127.0.0.1:8723", "admin");
    await client.removeAgent("@cli.bot");
  });

  it("updateAgent issues PATCH /_admin/agents/<handle> with policy + profile fields", async () => {
    const { calls } = withFetchMock([
      () =>
        new Response(
          JSON.stringify({
            handle: "@cli.bot",
            policy: "open",
            allowlist: [],
            display_name: "CLI Bot",
            description: null,
            card_body: null,
            visibility: "private",
          }),
          { status: 200 },
        ),
    ]);

    const client = new AdminClient("http://127.0.0.1:8723", "admin");
    await client.updateAgent("@cli.bot", {
      policy: "open",
      displayName: "CLI Bot",
      visibility: "private",
    });

    assert.equal(calls[0].init.method, "PATCH");
    assert.equal(
      calls[0].url,
      "http://127.0.0.1:8723/_admin/agents/%40cli.bot",
    );
    assert.equal(
      calls[0].init.body,
      JSON.stringify({
        policy: "open",
        display_name: "CLI Bot",
        visibility: "private",
      }),
    );
  });
});
