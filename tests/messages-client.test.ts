import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";

import { CapabilityNotSupportedError } from "../src/agents/errors.js";
import { AspApiError } from "../src/asp/errors.js";
import { MessageSearchClient } from "../src/messages/client.js";

const BASE = "https://api.example/v1";
const TOKEN = "test-bearer";
const NETWORK = "robotnet";

function makeClient(): MessageSearchClient {
  return new MessageSearchClient(BASE, TOKEN, NETWORK);
}

interface FetchCall {
  readonly url: string;
}

let originalFetch: typeof globalThis.fetch;
let calls: FetchCall[] = [];

beforeEach(() => {
  originalFetch = globalThis.fetch;
  calls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubFetch(handler: (url: string) => Response): void {
  globalThis.fetch = async (input: unknown) => {
    const url = typeof input === "string" ? input : String(input);
    calls.push({ url });
    return handler(url);
  };
}

describe("MessageSearchClient.searchMessages", () => {
  it("encodes query+limit and returns the messages array", async () => {
    stubFetch(() =>
      new Response(
        JSON.stringify({
          messages: [
            {
              id: "msg_01",
              session_id: "sess_01",
              sender: "@nick.cli",
              sequence: 1,
              content: "hello world",
              created_at: 1_700_000_000_000,
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const result = await makeClient().searchMessages({
      query: "hello world",
      limit: 5,
    });
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0]!.content, "hello world");

    const url = new URL(calls[0]!.url);
    assert.equal(url.pathname, "/v1/search/messages");
    assert.equal(url.searchParams.get("q"), "hello world");
    assert.equal(url.searchParams.get("limit"), "5");
    assert.equal(url.searchParams.get("session_id"), null);
    assert.equal(url.searchParams.get("counterpart"), null);
  });

  it("forwards optional session_id and counterpart filters", async () => {
    stubFetch(() => new Response(JSON.stringify({ messages: [] }), { status: 200 }));

    await makeClient().searchMessages({
      query: "ping",
      limit: 20,
      sessionId: "sess_06ABC",
      counterpartHandle: "@bob.bot",
    });

    const url = new URL(calls[0]!.url);
    assert.equal(url.searchParams.get("session_id"), "sess_06ABC");
    assert.equal(url.searchParams.get("counterpart"), "@bob.bot");
  });

  it("translates 404 to CapabilityNotSupportedError", async () => {
    stubFetch(() => new Response("", { status: 404 }));
    await assert.rejects(
      () => makeClient().searchMessages({ query: "x", limit: 20 }),
      CapabilityNotSupportedError,
    );
  });

  it("translates 405 and 501 to CapabilityNotSupportedError", async () => {
    for (const status of [405, 501]) {
      stubFetch(() => new Response("", { status }));
      await assert.rejects(
        () => makeClient().searchMessages({ query: "x", limit: 20 }),
        CapabilityNotSupportedError,
        `status ${status} should translate`,
      );
    }
  });

  it("propagates non-capability errors as AspApiError", async () => {
    stubFetch(() => new Response("", { status: 500 }));
    await assert.rejects(
      () => makeClient().searchMessages({ query: "x", limit: 20 }),
      AspApiError,
    );
  });
});
