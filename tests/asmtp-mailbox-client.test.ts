import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";

import { MailboxClient } from "../src/asmtp/mailbox-client.js";

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

describe("MailboxClient.list", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("hits GET /mailbox with no params on a fresh-install call", async () => {
    const { calls } = withFetchMock([
      () =>
        new Response(
          JSON.stringify({ envelope_headers: [], next_cursor: null }),
          { status: 200 },
        ),
    ]);
    const client = new MailboxClient("https://api.example/v1", "tok");
    await client.list();
    const url = new URL(calls[0]!.url);
    assert.equal(url.pathname, "/v1/mailbox");
    assert.equal(url.search, "");
  });

  it("encodes order, limit, unread, and cursor params", async () => {
    const { calls } = withFetchMock([
      () =>
        new Response(
          JSON.stringify({ envelope_headers: [], next_cursor: null }),
          { status: 200 },
        ),
    ]);
    const client = new MailboxClient("https://api.example/v1", "tok");
    await client.list({
      order: "asc",
      limit: 100,
      unread: true,
      after: {
        created_at: 1747000000000,
        envelope_id: "01HW7Z9KQX1MS2D9P5VC3GZ8AB",
      },
    });
    const url = new URL(calls[0]!.url);
    assert.equal(url.pathname, "/v1/mailbox");
    assert.equal(url.searchParams.get("order"), "asc");
    assert.equal(url.searchParams.get("limit"), "100");
    assert.equal(url.searchParams.get("unread"), "true");
    assert.equal(url.searchParams.get("after_created_at"), "1747000000000");
    assert.equal(
      url.searchParams.get("after_envelope_id"),
      "01HW7Z9KQX1MS2D9P5VC3GZ8AB",
    );
  });
});

describe("MailboxClient.markRead", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("POSTs the id list to /mailbox/read and returns the entitled subset", async () => {
    const { calls } = withFetchMock([
      () =>
        new Response(
          JSON.stringify({ read: ["01HW7Z9KQX1MS2D9P5VC3GZ8AB"] }),
          { status: 200 },
        ),
    ]);
    const client = new MailboxClient("https://api.example/v1", "tok");
    const result = await client.markRead([
      "01HW7Z9KQX1MS2D9P5VC3GZ8AB",
      "01HW7Z9KQX1MS2D9P5VC3GZ8AC",
    ]);
    assert.deepEqual(result, { read: ["01HW7Z9KQX1MS2D9P5VC3GZ8AB"] });

    const call = calls[0]!;
    assert.equal(call.url, "https://api.example/v1/mailbox/read");
    assert.equal(call.init.method, "POST");
    assert.deepEqual(JSON.parse(String(call.init.body)), {
      ids: [
        "01HW7Z9KQX1MS2D9P5VC3GZ8AB",
        "01HW7Z9KQX1MS2D9P5VC3GZ8AC",
      ],
    });
  });
});
