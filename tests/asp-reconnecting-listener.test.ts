import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { createServer } from "node:http";
import { AddressInfo } from "node:net";

import { WebSocket, WebSocketServer } from "ws";

import {
  startReconnectingAspListener,
  type TerminalFailure,
} from "../src/asp/reconnecting-listener.js";
import { RobotNetCLIError, TransientAuthError } from "../src/errors.js";

interface TestServer {
  readonly wsUrl: string;
  /** Forcibly drop every connected client without closing the server. Returns the count dropped. */
  dropAll(): number;
  /** Number of connections accepted across the server's lifetime. */
  connections(): number;
  /** Authorization header of every accepted handshake (handy to confirm a fresh token per attempt). */
  authorizations(): readonly string[];
  /** Push a JSON frame to every currently-open client socket. Used by dedup tests. */
  broadcast(frame: object): number;
  close(): Promise<void>;
}

async function startTestServer(): Promise<TestServer> {
  const httpServer = createServer();
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const port = (httpServer.address() as AddressInfo).port;
  const wss = new WebSocketServer({ server: httpServer });

  const auths: string[] = [];
  let count = 0;
  wss.on("connection", (_socket: WebSocket, req) => {
    count += 1;
    const a = req.headers["authorization"];
    auths.push(typeof a === "string" ? a : "");
  });

  return {
    wsUrl: `ws://127.0.0.1:${port}`,
    dropAll: (): number => {
      let dropped = 0;
      for (const c of wss.clients) {
        c.terminate();
        dropped += 1;
      }
      return dropped;
    },
    connections: (): number => count,
    authorizations: (): readonly string[] => auths.slice(),
    broadcast: (frame: object): number => {
      const payload = JSON.stringify(frame);
      let sent = 0;
      for (const c of wss.clients) {
        if (c.readyState === WebSocket.OPEN) {
          c.send(payload);
          sent += 1;
        }
      }
      return sent;
    },
    close: async (): Promise<void> => {
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      await new Promise<void>((r) => httpServer.close(() => r()));
    },
  };
}

/** Build a minimal SessionEvent-shaped frame with a stable event_id. */
function eventFrame(event_id: string, sequence = 1): object {
  return {
    type: "session.message",
    session_id: "sess_test",
    event_id,
    sequence,
    created_at: 1700000000000,
    payload: { id: "msg_test", sender: "@x.bot", content: "hi" },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: timed out");
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("startReconnectingAspListener", () => {
  it("reconnects after the server drops the socket and re-resolves credentials each time", async () => {
    const harness = await startTestServer();
    let resolveCalls = 0;
    const reconnectAttempts: number[] = [];

    const listener = startReconnectingAspListener({
      resolve: async () => {
        resolveCalls += 1;
        // Bake the call number into the token so we can verify each attempt
        // pulls a fresh value (i.e. token renewal would be picked up).
        return { wsUrl: harness.wsUrl, token: `tok-${resolveCalls}` };
      },
      onReconnectScheduled: (n) => reconnectAttempts.push(n),
      // Tight backoff for tests.
      initialDelayMs: 5,
      maxDelayMs: 20,
      resetAfterStableMs: 60_000,
      jitterRatio: 0,
    });

    await waitFor(() => harness.connections() === 1);
    harness.dropAll();
    await waitFor(() => harness.connections() === 2);
    harness.dropAll();
    await waitFor(() => harness.connections() === 3);

    assert.equal(resolveCalls, 3);
    // Tokens were re-resolved per attempt → Authorization headers differ.
    const auths = harness.authorizations();
    assert.deepEqual(auths, ["Bearer tok-1", "Bearer tok-2", "Bearer tok-3"]);

    // onReconnectScheduled was called for the 2nd and 3rd attempts (not the
    // initial connect).
    assert.deepEqual(reconnectAttempts.slice(0, 2), [1, 2]);

    listener.close();
    await harness.close();
  });

  it("backoff doubles on each successive failure and is capped by maxDelayMs", async () => {
    const harness = await startTestServer();
    const delays: number[] = [];

    const listener = startReconnectingAspListener({
      resolve: async () => ({ wsUrl: harness.wsUrl, token: "tok" }),
      onReconnectScheduled: (_attempt, delayMs) => delays.push(delayMs),
      initialDelayMs: 5,
      maxDelayMs: 40,
      resetAfterStableMs: 60_000,
      jitterRatio: 0,
    });

    // Drop five times to observe five backoff delays.
    for (let i = 0; i < 5; i++) {
      await waitFor(() => harness.connections() === i + 1);
      harness.dropAll();
    }
    await waitFor(() => delays.length >= 5);

    // No jitter → exact doubling: 5, 10, 20, 40, 40 (capped).
    assert.deepEqual(delays.slice(0, 5), [5, 10, 20, 40, 40]);

    listener.close();
    await harness.close();
  });

  it("backoff resets after a stable connection of resetAfterStableMs", async () => {
    const harness = await startTestServer();
    const delays: number[] = [];

    const listener = startReconnectingAspListener({
      resolve: async () => ({ wsUrl: harness.wsUrl, token: "tok" }),
      onReconnectScheduled: (_attempt, delayMs) => delays.push(delayMs),
      initialDelayMs: 5,
      maxDelayMs: 40,
      // Reset after just 50ms of stable so the test stays fast.
      resetAfterStableMs: 50,
      jitterRatio: 0,
    });

    // First drop → delay 5ms. Reconnect, stay open ≥50ms, then drop → delay 5ms again (reset).
    await waitFor(() => harness.connections() === 1);
    harness.dropAll();
    await waitFor(() => harness.connections() === 2);
    await new Promise((r) => setTimeout(r, 80)); // >50ms stable → reset
    harness.dropAll();
    await waitFor(() => harness.connections() === 3);
    await waitFor(() => delays.length >= 2);

    assert.deepEqual(delays.slice(0, 2), [5, 5]);

    listener.close();
    await harness.close();
  });

  it("close() cancels a pending reconnect and prevents future ones", async () => {
    const harness = await startTestServer();

    const listener = startReconnectingAspListener({
      resolve: async () => ({ wsUrl: harness.wsUrl, token: "tok" }),
      // Long-ish reconnect delay so we have time to call close() in between.
      initialDelayMs: 100,
      maxDelayMs: 100,
      resetAfterStableMs: 60_000,
      jitterRatio: 0,
    });

    await waitFor(() => harness.connections() === 1);
    harness.dropAll();
    listener.close();

    // Wait twice the reconnect delay and confirm no new connection.
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(harness.connections(), 1);

    await harness.close();
  });

  it("respects maxAttempts and stops reconnecting after the cap", async () => {
    const harness = await startTestServer();

    const listener = startReconnectingAspListener({
      resolve: async () => ({ wsUrl: harness.wsUrl, token: "tok" }),
      initialDelayMs: 5,
      maxDelayMs: 5,
      resetAfterStableMs: 60_000,
      jitterRatio: 0,
      maxAttempts: 2,
    });

    await waitFor(() => harness.connections() === 1);
    harness.dropAll();
    await waitFor(() => harness.connections() === 2);
    harness.dropAll();
    // Wait long enough that a third attempt would have happened.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(harness.connections(), 2);

    listener.close();
    await harness.close();
  });

  it("treats a resolve() failure as a reconnect-eligible error", async () => {
    const harness = await startTestServer();
    let calls = 0;
    const errors: string[] = [];

    const listener = startReconnectingAspListener({
      resolve: async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error("transient resolve failure");
        }
        return { wsUrl: harness.wsUrl, token: "tok" };
      },
      onError: (err) => errors.push(err.message),
      initialDelayMs: 5,
      maxDelayMs: 5,
      resetAfterStableMs: 60_000,
      jitterRatio: 0,
    });

    await waitFor(() => harness.connections() === 1);
    assert.equal(calls, 2);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /transient resolve failure/);

    listener.close();
    await harness.close();
  });

  it("fires onTerminalFailure(permanent_resolve_error) when resolve() throws a RobotNetCLIError", async () => {
    let calls = 0;
    const failures: TerminalFailure[] = [];

    const listener = startReconnectingAspListener({
      resolve: async () => {
        calls += 1;
        throw new RobotNetCLIError("no stored token for @x.y on network local");
      },
      onTerminalFailure: (f) => failures.push(f),
      initialDelayMs: 5,
      maxDelayMs: 5,
      jitterRatio: 0,
    });

    await waitFor(() => failures.length === 1);
    // Permanent errors must NOT trigger a retry, so resolve fires exactly once.
    assert.equal(calls, 1);
    assert.equal(failures[0]!.reason, "permanent_resolve_error");
    assert.match(failures[0]!.error.message, /no stored token/);

    listener.close();
  });

  it("treats TransientAuthError from resolve() as reconnect-eligible (does not fire onTerminalFailure)", async () => {
    const harness = await startTestServer();
    let calls = 0;
    const failures: TerminalFailure[] = [];

    const listener = startReconnectingAspListener({
      resolve: async () => {
        calls += 1;
        if (calls < 3) {
          throw new TransientAuthError("auth server returned 503");
        }
        return { wsUrl: harness.wsUrl, token: "tok" };
      },
      onTerminalFailure: (f) => failures.push(f),
      initialDelayMs: 5,
      maxDelayMs: 5,
      jitterRatio: 0,
    });

    await waitFor(() => harness.connections() === 1);
    assert.equal(calls, 3);
    assert.equal(failures.length, 0);

    listener.close();
    await harness.close();
  });

  it("fires onTerminalFailure(max_attempts_exhausted) when WebSocket drops exhaust the cap", async () => {
    const harness = await startTestServer();
    const failures: TerminalFailure[] = [];

    const listener = startReconnectingAspListener({
      resolve: async () => ({ wsUrl: harness.wsUrl, token: "tok" }),
      onTerminalFailure: (f) => failures.push(f),
      initialDelayMs: 5,
      maxDelayMs: 5,
      resetAfterStableMs: 60_000,
      jitterRatio: 0,
      maxAttempts: 2,
    });

    await waitFor(() => harness.connections() === 1);
    harness.dropAll();
    await waitFor(() => harness.connections() === 2);
    harness.dropAll();
    await waitFor(() => failures.length === 1);

    assert.equal(failures[0]!.reason, "max_attempts_exhausted");
    assert.equal(failures[0]!.attempts, 2);

    // After firing terminal, no further reconnects happen.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(harness.connections(), 2);

    listener.close();
    await harness.close();
  });

  it("onTerminalFailure fires at most once even if multiple permanent failures could trigger it", async () => {
    const failures: TerminalFailure[] = [];

    const listener = startReconnectingAspListener({
      resolve: async () => {
        throw new RobotNetCLIError("permanent");
      },
      onTerminalFailure: (f) => failures.push(f),
      initialDelayMs: 5,
      maxDelayMs: 5,
      jitterRatio: 0,
    });

    await waitFor(() => failures.length === 1);
    // Wait long enough that another doConnect cycle would have run.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(failures.length, 1);

    listener.close();
  });

  // ---------------------------------------------------------------------
  // Receiver-side dedup. The wire is at-least-once: catchup-vs-live
  // races and SQS redelivery can both produce the same event_id more
  // than once. The listener filters duplicates by event_id so the
  // perceived stream the caller's onEvent sees is exactly-once.
  // ---------------------------------------------------------------------

  it("dedup: drops a duplicate event_id within a single connection", async () => {
    const harness = await startTestServer();
    const seenEventIds: string[] = [];

    const listener = startReconnectingAspListener({
      resolve: async () => ({ wsUrl: harness.wsUrl, token: "tok" }),
      onEvent: (e) => seenEventIds.push(e.event_id),
      initialDelayMs: 5,
      maxDelayMs: 5,
      resetAfterStableMs: 60_000,
      jitterRatio: 0,
    });

    await waitFor(() => harness.connections() === 1);

    // Same event_id three times in a row — only the first should reach
    // the caller. Catchup-vs-live races and SQS redelivery on the
    // operator side both look exactly like this on the wire.
    harness.broadcast(eventFrame("evt_001"));
    harness.broadcast(eventFrame("evt_001"));
    harness.broadcast(eventFrame("evt_001"));

    await waitFor(() => seenEventIds.length >= 1, 1000);
    // Give two more event-loop ticks to confirm no further events land.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(seenEventIds, ["evt_001"]);

    listener.close();
    await harness.close();
  });

  it("dedup: distinct event_ids are all delivered, in order", async () => {
    const harness = await startTestServer();
    const seenEventIds: string[] = [];

    const listener = startReconnectingAspListener({
      resolve: async () => ({ wsUrl: harness.wsUrl, token: "tok" }),
      onEvent: (e) => seenEventIds.push(e.event_id),
      initialDelayMs: 5,
      maxDelayMs: 5,
      resetAfterStableMs: 60_000,
      jitterRatio: 0,
    });

    await waitFor(() => harness.connections() === 1);
    harness.broadcast(eventFrame("evt_001", 1));
    harness.broadcast(eventFrame("evt_002", 2));
    harness.broadcast(eventFrame("evt_003", 3));
    await waitFor(() => seenEventIds.length === 3, 1000);

    assert.deepEqual(seenEventIds, ["evt_001", "evt_002", "evt_003"]);

    listener.close();
    await harness.close();
  });

  it("dedup: persists across reconnects (catchup-after-drop is filtered)", async () => {
    // Real-world case: an event was delivered live before the drop;
    // after the new $connect, catchup replays the same event_id. The
    // dedup gate must remember the earlier delivery so the caller
    // doesn't see the same event twice across a reconnect boundary.
    const harness = await startTestServer();
    const seenEventIds: string[] = [];

    const listener = startReconnectingAspListener({
      resolve: async () => ({ wsUrl: harness.wsUrl, token: "tok" }),
      onEvent: (e) => seenEventIds.push(e.event_id),
      initialDelayMs: 5,
      maxDelayMs: 5,
      resetAfterStableMs: 60_000,
      jitterRatio: 0,
    });

    // Connection #1: deliver evt_A and evt_B.
    await waitFor(() => harness.connections() === 1);
    harness.broadcast(eventFrame("evt_A", 1));
    harness.broadcast(eventFrame("evt_B", 2));
    await waitFor(() => seenEventIds.length === 2);

    // Drop, reconnect. Connection #2 replays evt_B (catchup) then sends
    // a new evt_C live. Caller should only see evt_C as new.
    harness.dropAll();
    await waitFor(() => harness.connections() === 2);
    harness.broadcast(eventFrame("evt_B", 2));
    harness.broadcast(eventFrame("evt_C", 3));
    await waitFor(() => seenEventIds.length >= 3, 1000);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.deepEqual(seenEventIds, ["evt_A", "evt_B", "evt_C"]);

    listener.close();
    await harness.close();
  });
});
