import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { createServer } from "node:http";
import { AddressInfo } from "node:net";

import { WebSocketServer, type WebSocket } from "ws";

import { startReconnectingAsmtpListener } from "../src/asmtp/reconnecting-listener.js";
import type { ServerFrame } from "../src/asmtp/types.js";
import { RobotNetCLIError } from "../src/errors.js";

interface Harness {
  readonly wsUrl: string;
  readonly waitForClient: () => Promise<{
    readonly send: (raw: string) => void;
    readonly socket: WebSocket;
  }>;
  readonly close: () => Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const httpServer = createServer();
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const port = (httpServer.address() as AddressInfo).port;
  const wss = new WebSocketServer({ server: httpServer });

  // Latest connection is held in a small queue; tests pull one entry per
  // `waitForClient()` call. If a connection lands before the test asks,
  // it's buffered; if the test asks first, the next connection resolves
  // the awaited promise.
  const ready: Array<{ send: (raw: string) => void; socket: WebSocket }> = [];
  const waiters: Array<(value: { send: (raw: string) => void; socket: WebSocket }) => void> = [];

  wss.on("connection", (socket) => {
    const entry = { send: (raw: string) => socket.send(raw), socket };
    const next = waiters.shift();
    if (next !== undefined) next(entry);
    else ready.push(entry);
  });

  return {
    wsUrl: `ws://127.0.0.1:${port}`,
    waitForClient: () =>
      new Promise((resolve) => {
        const buffered = ready.shift();
        if (buffered !== undefined) resolve(buffered);
        else waiters.push(resolve);
      }),
    close: async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      await new Promise<void>((r) => httpServer.close(() => r()));
    },
  };
}

describe("startReconnectingAsmtpListener", () => {
  it("dedupes envelope.notify frames by id within a single connection", async () => {
    const harness = await startHarness();
    const frames: ServerFrame[] = [];

    const listener = startReconnectingAsmtpListener({
      initialDelayMs: 5,
      resolve: async () => ({ wsUrl: harness.wsUrl, token: "tok" }),
      onFrame: (frame) => frames.push(frame),
    });

    const client = await harness.waitForClient();
    const env = {
      op: "envelope.notify",
      id: "01HW7Z9KQX1MS2D9P5VC3GZ8AB",
      from: "@peer.bot",
      to: ["@me.dev"],
      type_hint: "text",
      created_at: 1,
      date_ms: 1,
    };
    // Send the same envelope twice — the LRU dedup gate inside the
    // reconnecting listener should suppress the duplicate.
    client.send(JSON.stringify(env));
    client.send(JSON.stringify(env));
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(frames.length, 1);

    listener.close();
    await harness.close();
  });

  it("fires onTerminalFailure when resolve throws a permanent RobotNetCLIError", async () => {
    let terminal: { reason: string } | null = null;
    const errors: string[] = [];
    const listener = startReconnectingAsmtpListener({
      initialDelayMs: 5,
      resolve: async () => {
        throw new RobotNetCLIError("missing credential");
      },
      onError: (err) => errors.push(err.message),
      onTerminalFailure: (failure) => {
        terminal = { reason: failure.reason };
      },
    });
    await waitFor(() => terminal !== null);
    assert.equal(terminal!.reason, "permanent_resolve_error");
    assert.ok(errors.includes("missing credential"));
    listener.close();
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: timed out");
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}
