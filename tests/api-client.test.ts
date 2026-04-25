import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { APIClient } from "../src/api/client.js";
import { APIError } from "../src/errors.js";
import { USER_AGENT } from "../src/version.js";

describe("APIClient", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("list_threads builds query and auth headers", async () => {
    const captured: { url: string; init: RequestInit }[] = [];

    globalThis.fetch = async (input, init) => {
      captured.push({ url: input as string, init: init! });
      return new Response(JSON.stringify({ threads: [] }), { status: 200 });
    };

    const client = new APIClient("https://api.example.test/v1", "bearer-token");
    const payload = await client.listThreads({ status: "active", limit: 5 });

    assert.deepEqual(payload, { threads: [] });
    assert.equal(captured.length, 1);
    const url = new URL(captured[0].url);
    assert.equal(url.pathname, "/v1/threads");
    assert.equal(url.searchParams.get("limit"), "5");
    assert.equal(url.searchParams.get("status"), "active");
    assert.equal(
      (captured[0].init.headers as Record<string, string>).Authorization,
      "Bearer bearer-token",
    );
  });

  it("sets User-Agent header on outbound requests", async () => {
    const captured: { init: RequestInit }[] = [];

    globalThis.fetch = async (_input, init) => {
      captured.push({ init: init! });
      return new Response(JSON.stringify({ threads: [] }), { status: 200 });
    };

    const client = new APIClient("https://api.example.test/v1", "bearer-token");
    await client.listThreads({});

    const headers = captured[0].init.headers as Record<string, string>;
    assert.equal(headers["User-Agent"], USER_AGENT);
  });

  it("send_message adds idempotency key", async () => {
    const captured: { url: string; init: RequestInit }[] = [];

    globalThis.fetch = async (input, init) => {
      captured.push({ url: input as string, init: init! });
      return new Response(JSON.stringify({ id: "msg_1" }), { status: 200 });
    };

    const client = new APIClient("https://api.example.test/v1", "bearer-token");
    const payload = await client.sendMessage("thd_1", "hello", {
      contentType: "markdown",
      reason: "follow up",
      attachmentIds: ["att_1"],
    });

    assert.deepEqual(payload, { id: "msg_1" });
    const headers = captured[0].init.headers as Record<string, string>;
    assert.ok("Idempotency-Key" in headers);
    const body = JSON.parse(captured[0].init.body as string);
    assert.deepEqual(body, {
      content: "hello",
      content_type: "markdown",
      reason: "follow up",
      attachment_ids: ["att_1"],
    });
  });

  it("get_agent_by_handle rejects handle without dot", async () => {
    const client = new APIClient("https://api.example.test/v1", "bearer-token");

    await assert.rejects(
      () => client.getAgentByHandle("invalid-handle"),
      APIError,
    );
  });

  it("get_agent_by_handle rejects handle with leading dot", async () => {
    const client = new APIClient("https://api.example.test/v1", "bearer-token");

    await assert.rejects(
      () => client.getAgentByHandle(".agent"),
      APIError,
    );
  });

  it("get_agent_by_handle rejects handle with trailing dot", async () => {
    const client = new APIClient("https://api.example.test/v1", "bearer-token");

    await assert.rejects(
      () => client.getAgentByHandle("owner."),
      APIError,
    );
  });

  it("get_agent_by_handle URL-encodes handle segments", async () => {
    const captured: { url: string }[] = [];

    globalThis.fetch = async (input, _init) => {
      captured.push({ url: input as string });
      return new Response(JSON.stringify({ agent: {} }), { status: 200 });
    };

    const client = new APIClient("https://api.example.test/v1", "bearer-token");
    await client.getAgentByHandle("owner.my agent");

    const url = new URL(captured[0].url);
    assert.equal(url.pathname, "/v1/agents/owner/my%20agent");
  });

  it("raises APIError for HTTP failures", async () => {
    globalThis.fetch = async () => {
      return new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403,
      });
    };

    const client = new APIClient("https://api.example.test/v1", "bearer-token");

    await assert.rejects(() => client.listContacts(), APIError);
  });
});
