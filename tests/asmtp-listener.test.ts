import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { createServer } from "node:http";
import { AddressInfo } from "node:net";

import { WebSocketServer } from "ws";

import { startAsmtpListener } from "../src/asmtp/listener.js";
import type { ServerFrame } from "../src/asmtp/types.js";

interface RunHarness {
  readonly wsUrl: string;
  readonly waitForClient: Promise<{
    readonly send: (raw: string) => void;
    readonly receivedFromClient: () => readonly string[];
    readonly url: string;
    readonly authorization: string | undefined;
  }>;
  readonly close: () => Promise<void>;
}

async function startTestServer(): Promise<RunHarness> {
  const httpServer = createServer();
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const port = (httpServer.address() as AddressInfo).port;
  const wss = new WebSocketServer({ server: httpServer });

  const waitForClient = new Promise<{
    send: (raw: string) => void;
    receivedFromClient: () => readonly string[];
    url: string;
    authorization: string | undefined;
  }>((resolve) => {
    wss.once("connection", (socket, req) => {
      const auth = req.headers["authorization"];
      const received: string[] = [];
      socket.on("message", (data) => {
        received.push(data.toString());
      });
      resolve({
        send: (raw) => socket.send(raw),
        receivedFromClient: () => [...received],
        url: req.url ?? "",
        authorization: typeof auth === "string" ? auth : undefined,
      });
    });
  });

  return {
    wsUrl: `ws://127.0.0.1:${port}`,
    waitForClient,
    close: async () => {
      for (const client of wss.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

describe("startAsmtpListener", () => {
  it("authenticates via the Authorization header and never sends a client frame", async () => {
    const harness = await startTestServer();
    const frames: ServerFrame[] = [];
    const listener = startAsmtpListener({
      wsUrl: harness.wsUrl,
      token: "tok-abc",
      onFrame: (frame) => frames.push(frame),
    });
    const client = await harness.waitForClient;
    assert.equal(client.authorization, "Bearer tok-abc");

    // Send a server-push envelope.notify and ensure the listener reports it.
    const frame = {
      op: "envelope.notify",
      id: "01HW7Z9KQX1MS2D9P5VC3GZ8AB",
      from: "@peer.bot",
      to: ["@me.dev"],
      type_hint: "text",
      created_at: 12345,
      date_ms: 12345,
    };
    client.send(JSON.stringify(frame));

    await waitFor(() => frames.length === 1);
    assert.equal(frames[0]!.op, "envelope.notify");
    // Pure server push: client must never write anything to the wire.
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(client.receivedFromClient(), []);

    listener.close();
    await harness.close();
  });

  it("dispatches monitor.fact frames as their own discriminant", async () => {
    const harness = await startTestServer();
    const frames: ServerFrame[] = [];
    const listener = startAsmtpListener({
      wsUrl: harness.wsUrl,
      token: "tok",
      onFrame: (frame) => frames.push(frame),
    });
    const client = await harness.waitForClient;
    const fact = {
      op: "monitor.fact",
      monitor: "mon_test",
      envelope_id: "01HW7Z9KQX1MS2D9P5VC3GZ8AB",
      recipient_handle: "@peer.bot",
      fact: "stored",
      at_ms: 12345,
    };
    client.send(JSON.stringify(fact));
    await waitFor(() => frames.length === 1);
    assert.equal(frames[0]!.op, "monitor.fact");

    listener.close();
    await harness.close();
  });

  it("routes shape-invalid frames to onUnparseable, not onFrame", async () => {
    const harness = await startTestServer();
    const frames: ServerFrame[] = [];
    const unparseable: string[] = [];
    const listener = startAsmtpListener({
      wsUrl: harness.wsUrl,
      token: "tok",
      onFrame: (f) => frames.push(f),
      onUnparseable: (raw) => unparseable.push(raw),
    });
    const client = await harness.waitForClient;
    client.send("not json");
    client.send(JSON.stringify({ op: "envelope.notify" })); // missing envelope fields
    client.send(JSON.stringify({ op: "unknown.op", id: "x" }));
    await waitFor(() => unparseable.length === 3);
    assert.equal(frames.length, 0);

    listener.close();
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
