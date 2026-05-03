import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";

import { AspSessionClient } from "../src/asp/session-client.js";
import { AspApiError } from "../src/asp/errors.js";

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

describe("AspSessionClient", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("createSession includes only fields the caller supplied", async () => {
    const { calls } = withFetchMock([
      () =>
        new Response(JSON.stringify({ session_id: "sess_X", sequence: 1 }), {
          status: 200,
        }),
    ]);

    const client = new AspSessionClient("http://127.0.0.1:8723", "tok");
    const out = await client.createSession({
      invite: ["@migration.bot"],
      topic: "migration plan",
      initialMessage: { content: "hi" },
      endAfterSend: false,
    });

    assert.deepEqual(out, { session_id: "sess_X", sequence: 1 });
    assert.equal(calls[0].url, "http://127.0.0.1:8723/sessions");
    const sentBody = JSON.parse(String(calls[0].init.body));
    assert.deepEqual(sentBody, {
      invite: ["@migration.bot"],
      topic: "migration plan",
      initial_message: { content: "hi" },
    });
    assert.equal(
      "end_after_send" in sentBody,
      false,
      "end_after_send=false should be omitted",
    );
  });

  it("createSession sends end_after_send when true", async () => {
    const { calls } = withFetchMock([
      () => new Response(JSON.stringify({ session_id: "sess_X" }), { status: 200 }),
    ]);

    const client = new AspSessionClient("http://127.0.0.1:8723", "tok");
    await client.createSession({
      invite: ["@migration.bot"],
      initialMessage: { content: "ok" },
      endAfterSend: true,
    });

    const sentBody = JSON.parse(String(calls[0].init.body));
    assert.equal(sentBody.end_after_send, true);
  });

  it("listSessions unwraps the {sessions: []} envelope", async () => {
    withFetchMock([
      () =>
        new Response(
          JSON.stringify({
            sessions: [
              {
                id: "sess_A",
                state: "active",
                participants: [],
                created_at: 1,
              },
            ],
          }),
          { status: 200 },
        ),
    ]);

    const client = new AspSessionClient("http://127.0.0.1:8723", "tok");
    const out = await client.listSessions();
    assert.equal(out.length, 1);
    assert.equal(out[0].id, "sess_A");
  });

  it("sendMessage forwards content and idempotency key", async () => {
    const { calls } = withFetchMock([
      () =>
        new Response(JSON.stringify({ message_id: "msg_1", sequence: 7 }), {
          status: 200,
        }),
    ]);

    const client = new AspSessionClient("http://127.0.0.1:8723", "tok");
    const out = await client.sendMessage("sess_A", "hello", {
      idempotencyKey: "k1",
    });
    assert.deepEqual(out, { message_id: "msg_1", sequence: 7 });
    assert.equal(
      calls[0].url,
      "http://127.0.0.1:8723/sessions/sess_A/messages",
    );
    const body = JSON.parse(String(calls[0].init.body));
    assert.deepEqual(body, { content: "hello", idempotency_key: "k1" });
  });

  it("getEvents serializes after_sequence and limit as query params", async () => {
    const { calls } = withFetchMock([
      () => new Response(JSON.stringify({ events: [] }), { status: 200 }),
    ]);

    const client = new AspSessionClient("http://127.0.0.1:8723", "tok");
    await client.getEvents("sess_A", { afterSequence: 12, limit: 50 });

    const url = new URL(calls[0].url);
    assert.equal(url.pathname, "/sessions/sess_A/events");
    assert.equal(url.searchParams.get("after_sequence"), "12");
    assert.equal(url.searchParams.get("limit"), "50");
  });

  it("getEvents omits the query string entirely when no options are passed", async () => {
    const { calls } = withFetchMock([
      () => new Response(JSON.stringify({ events: [] }), { status: 200 }),
    ]);

    const client = new AspSessionClient("http://127.0.0.1:8723", "tok");
    await client.getEvents("sess_A");

    assert.equal(calls[0].url, "http://127.0.0.1:8723/sessions/sess_A/events");
  });

  it("wsUrl swaps http→ws and points at /connect", () => {
    const a = new AspSessionClient("http://127.0.0.1:8723", "tok");
    assert.equal(a.wsUrl, "ws://127.0.0.1:8723/connect");

    const b = new AspSessionClient("https://api.example/v1", "tok");
    assert.equal(b.wsUrl, "wss://api.example/v1/connect");
  });

  it("inviteToSession sends invite array to /invite", async () => {
    const { calls } = withFetchMock([
      () =>
        new Response(JSON.stringify({ invited: ["@migration.bot"] }), {
          status: 200,
        }),
    ]);

    const client = new AspSessionClient("http://127.0.0.1:8723", "tok");
    const out = await client.inviteToSession("sess_A", ["@migration.bot"]);

    assert.deepEqual(out.invited, ["@migration.bot"]);
    assert.equal(
      calls[0].url,
      "http://127.0.0.1:8723/sessions/sess_A/invite",
    );
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
      invite: ["@migration.bot"],
    });
  });

  it("propagates AspApiError on non-2xx", async () => {
    withFetchMock([
      () =>
        new Response(JSON.stringify({ error: "session_not_found" }), {
          status: 404,
        }),
    ]);

    const client = new AspSessionClient("http://127.0.0.1:8723", "tok");
    await assert.rejects(
      () => client.showSession("sess_missing"),
      (err: unknown) => {
        assert.ok(err instanceof AspApiError);
        assert.equal(err.status, 404);
        assert.equal(err.code, "session_not_found");
        return true;
      },
    );
  });
});
