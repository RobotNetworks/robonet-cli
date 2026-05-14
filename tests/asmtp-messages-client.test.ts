import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";

import { MessagesClient } from "../src/asmtp/messages-client.js";
import { AsmtpApiError } from "../src/asmtp/errors.js";
import type { EnvelopePost } from "../src/asmtp/types.js";

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

describe("MessagesClient", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("POSTs the envelope body verbatim and returns the 202 response", async () => {
    const envelope: EnvelopePost = {
      id: "01HW7Z9KQX1MS2D9P5VC3GZ8AB",
      to: ["@peer.bot"],
      date_ms: 1747000000000,
      content_parts: [{ type: "text", text: "hi" }],
    };
    const response = {
      id: envelope.id,
      received_ms: 1747000000123,
      created_at: 1747000000123,
      recipients: [{ handle: "@peer.bot" }],
    };
    const { calls } = withFetchMock([
      () => new Response(JSON.stringify(response), { status: 202 }),
    ]);

    const client = new MessagesClient("https://api.example/v1", "tok");
    const result = await client.send(envelope);
    assert.deepEqual(result, response);

    const call = calls[0]!;
    assert.equal(call.url, "https://api.example/v1/messages");
    assert.equal(call.init.method, "POST");
    const headers = new Headers(call.init.headers);
    assert.equal(headers.get("Authorization"), "Bearer tok");
    assert.equal(headers.get("Content-Type"), "application/json");
    assert.ok(headers.has("Idempotency-Key"));
    assert.deepEqual(JSON.parse(String(call.init.body)), envelope);
  });

  it("fetchOne hits GET /messages/{id} and returns the envelope", async () => {
    const fetched = {
      id: "01HW7Z9KQX1MS2D9P5VC3GZ8AB",
      from: "@sender.bot",
      to: ["@me.dev"],
      date_ms: 1,
      content_parts: [{ type: "text", text: "hello" }],
    };
    const { calls } = withFetchMock([
      () => new Response(JSON.stringify(fetched), { status: 200 }),
    ]);

    const client = new MessagesClient("https://api.example/v1", "tok");
    const result = await client.fetchOne("01HW7Z9KQX1MS2D9P5VC3GZ8AB");
    assert.deepEqual(result, fetched);
    assert.equal(
      calls[0]!.url,
      "https://api.example/v1/messages/01HW7Z9KQX1MS2D9P5VC3GZ8AB",
    );
    assert.equal(calls[0]!.init.method, "GET");
  });

  it("fetchBatch encodes ids as comma-separated and returns the envelopes array", async () => {
    const ids = ["01HW7Z9KQX1MS2D9P5VC3GZ8AB", "01HW7Z9KQX1MS2D9P5VC3GZ8AC"];
    const { calls } = withFetchMock([
      () =>
        new Response(JSON.stringify({ envelopes: [] }), { status: 200 }),
    ]);

    const client = new MessagesClient("https://api.example/v1", "tok");
    const result = await client.fetchBatch(ids);
    assert.deepEqual(result, []);

    const url = new URL(calls[0]!.url);
    assert.equal(url.pathname, "/v1/messages");
    assert.equal(url.searchParams.get("ids"), ids.join(","));
  });

  it("fetchBatch with an empty id list returns [] without hitting the network", async () => {
    withFetchMock([]);
    const client = new MessagesClient("https://api.example/v1", "tok");
    const result = await client.fetchBatch([]);
    assert.deepEqual(result, []);
  });

  it("translates non-2xx into AsmtpApiError preserving the operator code", async () => {
    withFetchMock([
      () =>
        new Response(
          JSON.stringify({ error: { code: "RECIPIENT_NOT_FOUND", message: "no such handle" } }),
          { status: 404 },
        ),
    ]);
    const client = new MessagesClient("https://api.example/v1", "tok");
    await assert.rejects(
      () =>
        client.send({
          id: "01HW7Z9KQX1MS2D9P5VC3GZ8AB",
          to: ["@missing.bot"],
          date_ms: 1,
          content_parts: [{ type: "text", text: "hi" }],
        }),
      (err: unknown) =>
        err instanceof AsmtpApiError &&
        err.status === 404 &&
        err.code === "RECIPIENT_NOT_FOUND",
    );
  });
});
