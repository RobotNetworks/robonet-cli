import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { createServer } from "node:http";
import { AddressInfo } from "node:net";

import { WebSocketServer } from "ws";

import { startAspListener } from "../src/asp/listener.js";
import type { SessionEvent, UnknownSessionEvent } from "../src/asp/types.js";

interface RunHarness {
  readonly wsUrl: string;
  /** Resolves with `(send, requestUrl)` once the test client connects. */
  readonly waitForClient: Promise<{ readonly send: (raw: string) => void; readonly url: string }>;
  /** Tear down the WS server, terminating any still-connected sockets. */
  readonly close: () => Promise<void>;
}

async function startTestServer(): Promise<RunHarness> {
  const httpServer = createServer();
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const port = (httpServer.address() as AddressInfo).port;
  const wss = new WebSocketServer({ server: httpServer });

  const waitForClient = new Promise<{ send: (raw: string) => void; url: string }>(
    (resolve) => {
      wss.once("connection", (socket, req) => {
        resolve({
          send: (raw) => socket.send(raw),
          url: req.url ?? "",
        });
      });
    },
  );

  return {
    wsUrl: `ws://127.0.0.1:${port}`,
    waitForClient,
    close: async () => {
      // `wss.close()` and `httpServer.close()` both wait for active sockets to
      // finish, so we have to forcibly terminate any still-connected clients
      // first or the test process hangs after the suite resolves.
      for (const client of wss.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

describe("startAspListener", () => {
  it("forwards a known session.message event as a typed SessionEvent", async () => {
    const harness = await startTestServer();
    const events: Array<{ event: SessionEvent | UnknownSessionEvent; raw: string }> = [];
    const opens: number[] = [];

    const listener = startAspListener({
      wsUrl: harness.wsUrl,
      token: "tok-abc",
      onOpen: () => opens.push(Date.now()),
      onEvent: (event, raw) => events.push({ event, raw }),
    });

    const client = await harness.waitForClient;

    // Token must be on the handshake URL — the network authenticates this way.
    assert.match(client.url, /\?token=tok-abc$/);

    const frame = JSON.stringify({
      type: "session.message",
      session_id: "sess_A",
      event_id: "evt_1",
      sequence: 0,
      created_at: 12345,
      payload: {
        id: "msg_1",
        session_id: "sess_A",
        sender: "@migration.bot",
        sequence: 0,
        content: "hi",
        created_at: 12345,
      },
    });
    client.send(frame);

    await waitFor(() => events.length === 1);

    assert.equal(opens.length, 1);
    assert.equal(events[0].event.type, "session.message");
    assert.equal(events[0].raw, frame);

    listener.close();
    await harness.close();
  });

  it("classifies unrecognised event types as UnknownSessionEvent rather than dropping them", async () => {
    const harness = await startTestServer();
    const seen: Array<SessionEvent | UnknownSessionEvent> = [];

    const listener = startAspListener({
      wsUrl: harness.wsUrl,
      token: "tok",
      onEvent: (event) => seen.push(event),
    });

    const client = await harness.waitForClient;
    client.send(
      JSON.stringify({
        type: "session.future_thing_we_have_not_implemented",
        session_id: "sess_A",
        event_id: "evt_1",
        sequence: 0,
        created_at: 1,
        payload: { foo: "bar" },
      }),
    );

    await waitFor(() => seen.length === 1);
    assert.equal(seen[0].type, "session.future_thing_we_have_not_implemented");

    listener.close();
    await harness.close();
  });

  it("routes unparseable frames to onUnparseable, not onEvent", async () => {
    const harness = await startTestServer();
    const events: Array<unknown> = [];
    const unparseable: string[] = [];

    const listener = startAspListener({
      wsUrl: harness.wsUrl,
      token: "tok",
      onEvent: (event) => events.push(event),
      onUnparseable: (raw) => unparseable.push(raw),
    });

    const client = await harness.waitForClient;
    client.send("not json");
    client.send(JSON.stringify({ type: "session.message" })); // missing envelope fields

    await waitFor(() => unparseable.length === 2);
    assert.equal(events.length, 0);
    assert.equal(unparseable[0], "not json");

    listener.close();
    await harness.close();
  });

  it("close() shuts down the connection and onClose fires", async () => {
    const harness = await startTestServer();

    let closedCode: number | null = null;
    const listener = startAspListener({
      wsUrl: harness.wsUrl,
      token: "tok",
      onClose: (code) => {
        closedCode = code;
      },
    });

    await harness.waitForClient;
    listener.close();

    await waitFor(() => closedCode !== null);
    await harness.close();
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: timed out");
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}
