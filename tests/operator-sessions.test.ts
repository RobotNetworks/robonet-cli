import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import type Database from "better-sqlite3";
import { WebSocket } from "ws";

import type { OperatorConfig } from "../src/operator/config.js";
import { startOperatorServer, type OperatorHandle } from "../src/operator/server.js";
import { openOperatorDatabase } from "../src/operator/storage/database.js";
import { OperatorRepository } from "../src/operator/storage/repository.js";
import { sha256Hex } from "../src/operator/tokens.js";

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

interface Harness {
  readonly baseUrl: string;
  readonly wsUrl: string;
  readonly handle: OperatorHandle;
  readonly db: Database.Database;
  readonly repo: OperatorRepository;
  readonly adminToken: string;
  /** Test fixture: pre-registered agents with their plaintext bearer tokens (returned from POST /_admin/agents). */
  readonly tokens: Map<string, string>;
  readonly cleanup: () => Promise<void>;
}

async function pickPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr === null || typeof addr === "string") {
        reject(new Error("could not get assigned port"));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

async function makeHarness(opts: { readonly graceMs?: number } = {}): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "robotnet-op-sess-"));
  const dbPath = path.join(dir, "operator.sqlite");
  const port = await pickPort();
  const adminToken = "admin_" + Math.random().toString(36).slice(2);
  const config: OperatorConfig = {
    networkName: "local",
    host: "127.0.0.1",
    port,
    databasePath: dbPath,
    adminTokenHash: sha256Hex(adminToken),
    operatorVersion: "0.0.0-test",
  };
  const db = openOperatorDatabase(dbPath);
  const repo = new OperatorRepository(db);
  const handle = await startOperatorServer({
    config,
    db,
    repo,
    ...(opts.graceMs !== undefined ? { graceMs: opts.graceMs } : {}),
  });
  const baseUrl = `http://${handle.host}:${handle.port}`;
  const wsUrl = `ws://${handle.host}:${handle.port}`;
  return {
    baseUrl,
    wsUrl,
    handle,
    db,
    repo,
    adminToken,
    tokens: new Map(),
    cleanup: async () => {
      await handle.close();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function adminRegister(h: Harness, handle: string, opts: {
  readonly policy?: "open" | "allowlist";
  readonly allowlistEntries?: readonly string[];
} = {}): Promise<string> {
  const reg = await fetch(`${h.baseUrl}/_admin/agents`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${h.adminToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      handle,
      ...(opts.policy !== undefined ? { policy: opts.policy } : {}),
    }),
  });
  if (reg.status !== 201) {
    throw new Error(`register failed: ${reg.status} ${await reg.text()}`);
  }
  const created = (await reg.json()) as { token: string };
  h.tokens.set(handle, created.token);
  if (opts.allowlistEntries !== undefined && opts.allowlistEntries.length > 0) {
    const al = await fetch(
      `${h.baseUrl}/_admin/agents/${encodeURIComponent(handle)}/allowlist`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${h.adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ entries: opts.allowlistEntries }),
      },
    );
    if (al.status !== 200) {
      throw new Error(`allowlist add failed: ${al.status}`);
    }
  }
  return created.token;
}

function agentHeaders(h: Harness, handle: string): Record<string, string> {
  const token = h.tokens.get(handle);
  if (token === undefined) throw new Error(`no token for ${handle}`);
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

/** Open a `/connect` socket, return a frame collector. */
async function openConnect(h: Harness, handle: string): Promise<{
  readonly ws: WebSocket;
  readonly frames: unknown[];
  readonly waitForFrame: (predicate: (f: unknown) => boolean, timeoutMs?: number) => Promise<unknown>;
  close(): Promise<void>;
}> {
  const token = h.tokens.get(handle);
  if (token === undefined) throw new Error(`no token for ${handle}`);
  const ws = new WebSocket(`${h.wsUrl}/connect?token=${encodeURIComponent(token)}`);
  const frames: unknown[] = [];
  const listeners = new Set<(f: unknown) => void>();
  ws.on("message", (raw) => {
    const f: unknown = JSON.parse(raw.toString("utf-8"));
    frames.push(f);
    for (const l of listeners) l(f);
  });
  await new Promise<void>((resolve, reject) => {
    const onErr = (e: Error): void => reject(e);
    ws.once("error", onErr);
    ws.once("open", () => {
      ws.removeListener("error", onErr);
      resolve();
    });
  });
  return {
    ws,
    frames,
    waitForFrame: (predicate, timeoutMs = 1_000) => {
      const matchExisting = frames.find(predicate);
      if (matchExisting !== undefined) return Promise.resolve(matchExisting);
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(handler);
          reject(new Error("timeout waiting for frame"));
        }, timeoutMs);
        const handler = (f: unknown): void => {
          if (predicate(f)) {
            clearTimeout(timer);
            listeners.delete(handler);
            resolve(f);
          }
        };
        listeners.add(handler);
      });
    },
    close: () => new Promise<void>((resolve) => {
      if (ws.readyState === ws.CLOSED) return resolve();
      ws.once("close", () => resolve());
      ws.close();
    }),
  };
}

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(async () => {
  await h.cleanup();
});

/* -------------------------------------------------------------------------- */
/* Test cases                                                                  */
/* -------------------------------------------------------------------------- */

describe("operator sessions — create + invite", () => {
  it("creates a session and delivers session.invited live to invitees", async () => {
    await adminRegister(h, "@alice.bot");
    await adminRegister(h, "@bob.bot", {
      policy: "allowlist",
      allowlistEntries: ["@alice.bot"],
    });

    const bob = await openConnect(h, "@bob.bot");
    try {
      const res = await fetch(`${h.baseUrl}/sessions`, {
        method: "POST",
        headers: agentHeaders(h, "@alice.bot"),
        body: JSON.stringify({ invite: ["@bob.bot"], topic: "hello" }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { session_id: string };
      assert.match(body.session_id, /^sess_/);

      const invited = await bob.waitForFrame(
        (f) =>
          typeof f === "object" &&
          f !== null &&
          (f as Record<string, unknown>).type === "session.invited",
      );
      const ev = invited as Record<string, unknown>;
      const payload = ev.payload as Record<string, unknown>;
      assert.equal(payload.invitee, "@bob.bot");
      assert.equal(payload.by, "@alice.bot");
      assert.equal(payload.topic, "hello");
    } finally {
      await bob.close();
    }
  });

  it("rejects creation when an invitee is unreachable (privacy: 404)", async () => {
    await adminRegister(h, "@alice.bot");
    await adminRegister(h, "@bob.bot"); // policy=allowlist, no entries → unreachable

    const res = await fetch(`${h.baseUrl}/sessions`, {
      method: "POST",
      headers: agentHeaders(h, "@alice.bot"),
      body: JSON.stringify({ invite: ["@bob.bot"] }),
    });
    assert.equal(res.status, 404);
  });

  it("open-policy invitees are reachable by anyone", async () => {
    await adminRegister(h, "@alice.bot");
    await adminRegister(h, "@bob.bot", { policy: "open" });

    const res = await fetch(`${h.baseUrl}/sessions`, {
      method: "POST",
      headers: agentHeaders(h, "@alice.bot"),
      body: JSON.stringify({ invite: ["@bob.bot"] }),
    });
    assert.equal(res.status, 200);
  });
});

describe("operator sessions — join + send_message", () => {
  it("invitee joins and then receives session.message events", async () => {
    await adminRegister(h, "@alice.bot");
    await adminRegister(h, "@bob.bot", {
      policy: "allowlist",
      allowlistEntries: ["@alice.bot"],
    });

    const bob = await openConnect(h, "@bob.bot");
    try {
      const create = await fetch(`${h.baseUrl}/sessions`, {
        method: "POST",
        headers: agentHeaders(h, "@alice.bot"),
        body: JSON.stringify({ invite: ["@bob.bot"] }),
      });
      const { session_id } = (await create.json()) as { session_id: string };

      // Bob joins.
      const join = await fetch(
        `${h.baseUrl}/sessions/${session_id}/join`,
        { method: "POST", headers: agentHeaders(h, "@bob.bot") },
      );
      assert.equal(join.status, 200);

      // Alice sends a message.
      const send = await fetch(
        `${h.baseUrl}/sessions/${session_id}/messages`,
        {
          method: "POST",
          headers: agentHeaders(h, "@alice.bot"),
          body: JSON.stringify({ content: "hello bob" }),
        },
      );
      assert.equal(send.status, 200);

      const msg = await bob.waitForFrame(
        (f) =>
          typeof f === "object" &&
          f !== null &&
          (f as Record<string, unknown>).type === "session.message",
      );
      const payload = (msg as Record<string, unknown>).payload as Record<string, unknown>;
      assert.equal(payload.content, "hello bob");
      assert.equal(payload.sender, "@alice.bot");
      assert.equal(payload.session_id, session_id);
    } finally {
      await bob.close();
    }
  });

  it("invited (not yet joined) does NOT receive session.message", async () => {
    await adminRegister(h, "@alice.bot");
    await adminRegister(h, "@bob.bot", {
      policy: "allowlist",
      allowlistEntries: ["@alice.bot"],
    });

    const bob = await openConnect(h, "@bob.bot");
    try {
      const create = await fetch(`${h.baseUrl}/sessions`, {
        method: "POST",
        headers: agentHeaders(h, "@alice.bot"),
        body: JSON.stringify({ invite: ["@bob.bot"] }),
      });
      const { session_id } = (await create.json()) as { session_id: string };

      // Wait for the invite to land before sending.
      await bob.waitForFrame(
        (f) =>
          typeof f === "object" &&
          f !== null &&
          (f as Record<string, unknown>).type === "session.invited",
      );

      // Alice sends a message — Bob is invited, not joined.
      await fetch(`${h.baseUrl}/sessions/${session_id}/messages`, {
        method: "POST",
        headers: agentHeaders(h, "@alice.bot"),
        body: JSON.stringify({ content: "shouldn't reach bob" }),
      });

      // Wait briefly and confirm no session.message arrived for Bob.
      await new Promise((r) => setTimeout(r, 100));
      const messageFrames = bob.frames.filter(
        (f) =>
          typeof f === "object" &&
          f !== null &&
          (f as Record<string, unknown>).type === "session.message",
      );
      assert.equal(messageFrames.length, 0);
    } finally {
      await bob.close();
    }
  });

  it("idempotency_key replays the same (message_id, sequence)", async () => {
    await adminRegister(h, "@alice.bot");

    const create = await fetch(`${h.baseUrl}/sessions`, {
      method: "POST",
      headers: agentHeaders(h, "@alice.bot"),
      body: JSON.stringify({ invite: [] }),
    });
    const { session_id } = (await create.json()) as { session_id: string };

    const send1 = await fetch(`${h.baseUrl}/sessions/${session_id}/messages`, {
      method: "POST",
      headers: agentHeaders(h, "@alice.bot"),
      body: JSON.stringify({ content: "once", idempotency_key: "k1" }),
    });
    const r1 = (await send1.json()) as { message_id: string; sequence: number };

    const send2 = await fetch(`${h.baseUrl}/sessions/${session_id}/messages`, {
      method: "POST",
      headers: agentHeaders(h, "@alice.bot"),
      body: JSON.stringify({ content: "different content", idempotency_key: "k1" }),
    });
    const r2 = (await send2.json()) as { message_id: string; sequence: number };

    assert.equal(r2.message_id, r1.message_id);
    assert.equal(r2.sequence, r1.sequence);
  });
});

describe("operator sessions — leave + end + history", () => {
  it("leave moves participant to left, end transitions session, history is eligibility-filtered", async () => {
    await adminRegister(h, "@alice.bot");
    await adminRegister(h, "@bob.bot", {
      policy: "allowlist",
      allowlistEntries: ["@alice.bot"],
    });

    // Create + bob joins + alice sends.
    const create = await fetch(`${h.baseUrl}/sessions`, {
      method: "POST",
      headers: agentHeaders(h, "@alice.bot"),
      body: JSON.stringify({ invite: ["@bob.bot"] }),
    });
    const { session_id } = (await create.json()) as { session_id: string };
    await fetch(`${h.baseUrl}/sessions/${session_id}/join`, {
      method: "POST",
      headers: agentHeaders(h, "@bob.bot"),
    });
    await fetch(`${h.baseUrl}/sessions/${session_id}/messages`, {
      method: "POST",
      headers: agentHeaders(h, "@alice.bot"),
      body: JSON.stringify({ content: "hi" }),
    });

    // Bob leaves.
    const leave = await fetch(`${h.baseUrl}/sessions/${session_id}/leave`, {
      method: "POST",
      headers: agentHeaders(h, "@bob.bot"),
    });
    assert.equal(leave.status, 204);

    // Bob gets nothing past their left event in history.
    const histRes = await fetch(`${h.baseUrl}/sessions/${session_id}/events`, {
      headers: agentHeaders(h, "@bob.bot"),
    });
    const hist = (await histRes.json()) as { events: { type: string }[] };
    const types = hist.events.map((e) => e.type);
    assert.ok(types.includes("session.invited"));
    // session.joined for the joiner is intentionally absent: at the time
    // the event fires, the participant's status is still "invited", which
    // the eligibility filter rejects for non-{invited,ended} event types.
    // Live delivery is a separate path; the joiner already sees their
    // join via the live stream while the transition is in flight.
    assert.ok(types.includes("session.message"));
    assert.ok(types.includes("session.left"));

    // End by alice.
    const end = await fetch(`${h.baseUrl}/sessions/${session_id}/end`, {
      method: "POST",
      headers: agentHeaders(h, "@alice.bot"),
    });
    assert.equal(end.status, 204);

    // Bob's history does NOT include the session.ended fired after his left.
    const histAfterEnd = await fetch(
      `${h.baseUrl}/sessions/${session_id}/events`,
      { headers: agentHeaders(h, "@bob.bot") },
    );
    const histB = (await histAfterEnd.json()) as { events: { type: string }[] };
    assert.ok(!histB.events.some((e) => e.type === "session.ended"));

    // Sending into an ended session 409s.
    const sendDead = await fetch(
      `${h.baseUrl}/sessions/${session_id}/messages`,
      {
        method: "POST",
        headers: agentHeaders(h, "@alice.bot"),
        body: JSON.stringify({ content: "no" }),
      },
    );
    assert.equal(sendDead.status, 409);
  });
});

describe("operator sessions — replay on (re)connect", () => {
  it("an offline invitee gets session.invited replayed on connect", async () => {
    await adminRegister(h, "@alice.bot");
    await adminRegister(h, "@bob.bot", {
      policy: "allowlist",
      allowlistEntries: ["@alice.bot"],
    });

    // Create the session WITHOUT bob being connected.
    const create = await fetch(`${h.baseUrl}/sessions`, {
      method: "POST",
      headers: agentHeaders(h, "@alice.bot"),
      body: JSON.stringify({ invite: ["@bob.bot"] }),
    });
    assert.equal(create.status, 200);

    // Now bob connects and should immediately receive the invite via replay.
    const bob = await openConnect(h, "@bob.bot");
    try {
      const invited = await bob.waitForFrame(
        (f) =>
          typeof f === "object" &&
          f !== null &&
          (f as Record<string, unknown>).type === "session.invited",
      );
      assert.notEqual(invited, undefined);
    } finally {
      await bob.close();
    }
  });
});

describe("operator sessions — reopen", () => {
  it("reopens an ended session, peers see session.reopened, send works again", async () => {
    await adminRegister(h, "@alice.bot");
    await adminRegister(h, "@bob.bot", {
      policy: "allowlist",
      allowlistEntries: ["@alice.bot"],
    });

    const create = await fetch(`${h.baseUrl}/sessions`, {
      method: "POST",
      headers: agentHeaders(h, "@alice.bot"),
      body: JSON.stringify({ invite: ["@bob.bot"] }),
    });
    const { session_id } = (await create.json()) as { session_id: string };
    await fetch(`${h.baseUrl}/sessions/${session_id}/join`, {
      method: "POST",
      headers: agentHeaders(h, "@bob.bot"),
    });
    await fetch(`${h.baseUrl}/sessions/${session_id}/end`, {
      method: "POST",
      headers: agentHeaders(h, "@alice.bot"),
    });

    const bob = await openConnect(h, "@bob.bot");
    try {
      const reopen = await fetch(`${h.baseUrl}/sessions/${session_id}/reopen`, {
        method: "POST",
        headers: agentHeaders(h, "@alice.bot"),
        body: JSON.stringify({}),
      });
      assert.equal(reopen.status, 200);
      // session_id must be preserved (Whitepaper §6.3).
      const view = await fetch(`${h.baseUrl}/sessions/${session_id}`, {
        headers: agentHeaders(h, "@alice.bot"),
      });
      const body = (await view.json()) as { id: string; state: string };
      assert.equal(body.id, session_id);
      assert.equal(body.state, "active");
      // bob receives session.reopened — he was joined when the session ended,
      // so eligibility filter still passes (status === "joined" because
      // ending a session doesn't change participant status).
      const reopened = await bob.waitForFrame(
        (f) =>
          typeof f === "object" &&
          f !== null &&
          (f as Record<string, unknown>).type === "session.reopened",
      );
      assert.notEqual(reopened, undefined);

      // Sending into a reopened session works again.
      const send = await fetch(
        `${h.baseUrl}/sessions/${session_id}/messages`,
        {
          method: "POST",
          headers: agentHeaders(h, "@alice.bot"),
          body: JSON.stringify({ content: "after reopen" }),
        },
      );
      assert.equal(send.status, 200);
    } finally {
      await bob.close();
    }
  });

  it("reopen on an active session is 409", async () => {
    await adminRegister(h, "@alice.bot");
    const create = await fetch(`${h.baseUrl}/sessions`, {
      method: "POST",
      headers: agentHeaders(h, "@alice.bot"),
      body: JSON.stringify({ invite: [] }),
    });
    const { session_id } = (await create.json()) as { session_id: string };
    const reopen = await fetch(`${h.baseUrl}/sessions/${session_id}/reopen`, {
      method: "POST",
      headers: agentHeaders(h, "@alice.bot"),
      body: JSON.stringify({}),
    });
    assert.equal(reopen.status, 409);
  });
});

describe("operator sessions — presence transitions", () => {
  it("session.disconnected fires to peers when a joined participant's WS closes", async () => {
    // Use a tight grace so the followup test of grace_expired doesn't drag.
    await h.cleanup();
    h = await makeHarness({ graceMs: 5_000 });

    await adminRegister(h, "@alice.bot");
    await adminRegister(h, "@bob.bot", {
      policy: "allowlist",
      allowlistEntries: ["@alice.bot"],
    });

    // Both online, both joined.
    const alice = await openConnect(h, "@alice.bot");
    const create = await fetch(`${h.baseUrl}/sessions`, {
      method: "POST",
      headers: agentHeaders(h, "@alice.bot"),
      body: JSON.stringify({ invite: ["@bob.bot"] }),
    });
    const { session_id } = (await create.json()) as { session_id: string };
    const bob = await openConnect(h, "@bob.bot");
    try {
      await fetch(`${h.baseUrl}/sessions/${session_id}/join`, {
        method: "POST",
        headers: agentHeaders(h, "@bob.bot"),
      });
      // Wait for alice to see bob's join so the timeline is settled.
      await alice.waitForFrame(
        (f) =>
          typeof f === "object" &&
          f !== null &&
          (f as Record<string, unknown>).type === "session.joined",
      );

      // Bob disconnects.
      await bob.close();

      // Alice should receive session.disconnected for bob.
      const dropped = await alice.waitForFrame(
        (f) =>
          typeof f === "object" &&
          f !== null &&
          (f as Record<string, unknown>).type === "session.disconnected" &&
          ((f as Record<string, unknown>).payload as Record<string, unknown>).agent ===
            "@bob.bot",
      );
      assert.notEqual(dropped, undefined);
    } finally {
      await alice.close();
    }
  });

  it("session.reconnected fires when the handle returns within grace", async () => {
    await h.cleanup();
    h = await makeHarness({ graceMs: 5_000 });

    await adminRegister(h, "@alice.bot");
    await adminRegister(h, "@bob.bot", {
      policy: "allowlist",
      allowlistEntries: ["@alice.bot"],
    });

    const alice = await openConnect(h, "@alice.bot");
    const create = await fetch(`${h.baseUrl}/sessions`, {
      method: "POST",
      headers: agentHeaders(h, "@alice.bot"),
      body: JSON.stringify({ invite: ["@bob.bot"] }),
    });
    const { session_id } = (await create.json()) as { session_id: string };

    let bob = await openConnect(h, "@bob.bot");
    try {
      await fetch(`${h.baseUrl}/sessions/${session_id}/join`, {
        method: "POST",
        headers: agentHeaders(h, "@bob.bot"),
      });
      await alice.waitForFrame(
        (f) =>
          typeof f === "object" &&
          f !== null &&
          (f as Record<string, unknown>).type === "session.joined",
      );

      await bob.close();
      await alice.waitForFrame(
        (f) =>
          typeof f === "object" &&
          f !== null &&
          (f as Record<string, unknown>).type === "session.disconnected",
      );

      // Reconnect within grace.
      bob = await openConnect(h, "@bob.bot");
      const reconnected = await alice.waitForFrame(
        (f) =>
          typeof f === "object" &&
          f !== null &&
          (f as Record<string, unknown>).type === "session.reconnected" &&
          ((f as Record<string, unknown>).payload as Record<string, unknown>).agent ===
            "@bob.bot",
      );
      assert.notEqual(reconnected, undefined);
    } finally {
      await bob.close();
      await alice.close();
    }
  });

  it("session.left{grace_expired} fires after the grace window closes", async () => {
    await h.cleanup();
    h = await makeHarness({ graceMs: 100 });

    await adminRegister(h, "@alice.bot");
    await adminRegister(h, "@bob.bot", {
      policy: "allowlist",
      allowlistEntries: ["@alice.bot"],
    });

    const alice = await openConnect(h, "@alice.bot");
    const create = await fetch(`${h.baseUrl}/sessions`, {
      method: "POST",
      headers: agentHeaders(h, "@alice.bot"),
      body: JSON.stringify({ invite: ["@bob.bot"] }),
    });
    const { session_id } = (await create.json()) as { session_id: string };

    const bob = await openConnect(h, "@bob.bot");
    try {
      await fetch(`${h.baseUrl}/sessions/${session_id}/join`, {
        method: "POST",
        headers: agentHeaders(h, "@bob.bot"),
      });
      await alice.waitForFrame(
        (f) =>
          typeof f === "object" &&
          f !== null &&
          (f as Record<string, unknown>).type === "session.joined",
      );
      await bob.close();
      // Wait for grace to expire.
      const expired = await alice.waitForFrame(
        (f) =>
          typeof f === "object" &&
          f !== null &&
          (f as Record<string, unknown>).type === "session.left" &&
          ((f as Record<string, unknown>).payload as Record<string, unknown>).reason ===
            "grace_expired",
        2_000,
      );
      assert.notEqual(expired, undefined);

      // Bob is now "left" in the participants table.
      const view = await fetch(`${h.baseUrl}/sessions/${session_id}`, {
        headers: agentHeaders(h, "@alice.bot"),
      });
      const body = (await view.json()) as {
        participants: { handle: string; status: string }[];
      };
      const bobP = body.participants.find((p) => p.handle === "@bob.bot");
      assert.equal(bobP?.status, "left");
    } finally {
      await alice.close();
    }
  });
});

describe("operator sessions — auth", () => {
  it("rejects /sessions without a bearer", async () => {
    const res = await fetch(`${h.baseUrl}/sessions`, {
      method: "POST",
      body: JSON.stringify({ invite: [] }),
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(res.status, 401);
  });

  it("/connect rejects an invalid token", async () => {
    const ws = new WebSocket(`${h.wsUrl}/connect?token=bogus`);
    await new Promise<void>((resolve) => {
      ws.once("error", () => resolve());
      ws.once("close", () => resolve());
      ws.once("unexpected-response", () => resolve());
    });
    assert.notEqual(ws.readyState, ws.OPEN);
  });
});
