import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type Database from "better-sqlite3";

import {
  openOperatorDatabase,
  readSchemaVersion,
  smokeCheckSqliteBinding,
} from "../src/operator/storage/database.js";
import { OperatorRepository } from "../src/operator/storage/repository.js";
import { CURRENT_SCHEMA_VERSION } from "../src/operator/storage/schema.js";

interface Harness {
  readonly db: Database.Database;
  readonly repo: OperatorRepository;
  readonly cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "robotnet-operator-storage-"));
  const dbPath = path.join(dir, "operator.sqlite");
  const db = openOperatorDatabase(dbPath);
  const repo = new OperatorRepository(db);
  return {
    db,
    repo,
    cleanup: () => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(() => {
  h.cleanup();
});

describe("smokeCheckSqliteBinding", () => {
  it("returns without throwing when the better-sqlite3 native binding loads", () => {
    // Synchronous return = the native binding loaded and a trivial query
    // executed. This is what the operator entrypoint runs before binding
    // any port; if it ever started throwing in CI we'd want to know
    // immediately rather than catching it via integration tests.
    smokeCheckSqliteBinding();
  });
});

describe("operator database — schema + migrations", () => {
  it("opens at the current schema version", () => {
    assert.equal(readSchemaVersion(h.db), CURRENT_SCHEMA_VERSION);
  });

  it("re-opening an existing DB does not bump the version or duplicate rows", () => {
    h.repo.agents.register({ handle: "@x.y", bearerTokenHash: "h".repeat(64) });
    const dbPath = (h.db.name as string) ?? "";
    h.db.close();
    const reopened = openOperatorDatabase(dbPath);
    try {
      assert.equal(readSchemaVersion(reopened), CURRENT_SCHEMA_VERSION);
      const repo = new OperatorRepository(reopened);
      const agents = repo.agents.list();
      assert.equal(agents.length, 1);
      assert.equal(agents[0].handle, "@x.y");
    } finally {
      reopened.close();
    }
  });

  it("forces 0o600 file mode on POSIX", { skip: process.platform === "win32" }, () => {
    const filePath = h.db.name as string;
    const mode = fs.statSync(filePath).mode & 0o777;
    assert.equal(mode, 0o600);
  });
});

describe("AgentsRepo", () => {
  it("registers, looks up, lists, and removes agents", () => {
    const r = h.repo.agents.register({
      handle: "@example.bot",
      bearerTokenHash: "a".repeat(64),
      inboundPolicy: "allowlist",
      metadata: { profile: "test" },
    });
    assert.equal(r.handle, "@example.bot");
    assert.equal(r.inboundPolicy, "allowlist");
    assert.deepEqual(r.metadata, { profile: "test" });

    const byHandle = h.repo.agents.byHandle("@example.bot");
    assert.deepEqual(byHandle, r);

    const byHash = h.repo.agents.byBearerHash("a".repeat(64));
    assert.deepEqual(byHash, r);

    h.repo.agents.register({ handle: "@another.bot", bearerTokenHash: "b".repeat(64) });
    const list = h.repo.agents.list();
    assert.equal(list.length, 2);
    assert.deepEqual(
      list.map((a) => a.handle),
      ["@another.bot", "@example.bot"],
    );

    assert.equal(h.repo.agents.remove("@example.bot"), true);
    assert.equal(h.repo.agents.byHandle("@example.bot"), null);
    assert.equal(h.repo.agents.remove("@example.bot"), false);
  });

  it("rotates bearer hashes and refuses duplicates via UNIQUE", () => {
    h.repo.agents.register({ handle: "@a.b", bearerTokenHash: "1".repeat(64) });
    h.repo.agents.register({ handle: "@c.d", bearerTokenHash: "2".repeat(64) });
    assert.equal(
      h.repo.agents.rotateBearerHash("@a.b", "3".repeat(64)),
      true,
    );
    assert.equal(
      h.repo.agents.byHandle("@a.b")?.bearerTokenHash,
      "3".repeat(64),
    );
    // Rotating into an already-used hash raises a UNIQUE-constraint error.
    assert.throws(
      () => h.repo.agents.rotateBearerHash("@a.b", "2".repeat(64)),
      /UNIQUE/,
    );
  });

  it("inbound_policy can be flipped between open/allowlist", () => {
    h.repo.agents.register({ handle: "@a.b", bearerTokenHash: "z".repeat(64) });
    assert.equal(h.repo.agents.byHandle("@a.b")?.inboundPolicy, "allowlist");
    h.repo.agents.setInboundPolicy("@a.b", "open");
    assert.equal(h.repo.agents.byHandle("@a.b")?.inboundPolicy, "open");
  });

  it("remove cascades through sessions, participants, and delivery cursors", () => {
    // Regression: pre-fix, removing an agent that had ever created a
    // session raised `SqliteError: FOREIGN KEY constraint failed` because
    // sessions.creator_handle is a non-cascading FK. The repo now deletes
    // dependents in a transaction.
    h.repo.agents.register({ handle: "@creator.bot", bearerTokenHash: "c".repeat(64) });
    h.repo.agents.register({ handle: "@peer.bot", bearerTokenHash: "p".repeat(64) });
    h.repo.sessions.create({ id: "sess_01", creatorHandle: "@creator.bot" });
    h.repo.participants.add("sess_01", "@creator.bot", "joined");
    h.repo.participants.add("sess_01", "@peer.bot", "invited");

    assert.equal(h.repo.agents.remove("@creator.bot"), true);

    // Agent is gone.
    assert.equal(h.repo.agents.byHandle("@creator.bot"), null);
    // Session created by them is cascaded out.
    assert.equal(h.repo.sessions.byId("sess_01"), null);
    // The peer agent (unrelated) is untouched.
    assert.notEqual(h.repo.agents.byHandle("@peer.bot"), null);
  });

  it("remove also clears participation rows in OTHER agents' sessions", () => {
    h.repo.agents.register({ handle: "@host.bot", bearerTokenHash: "h".repeat(64) });
    h.repo.agents.register({ handle: "@guest.bot", bearerTokenHash: "g".repeat(64) });
    h.repo.sessions.create({ id: "sess_01", creatorHandle: "@host.bot" });
    h.repo.participants.add("sess_01", "@host.bot", "joined");
    h.repo.participants.add("sess_01", "@guest.bot", "joined");

    assert.equal(h.repo.agents.remove("@guest.bot"), true);

    // The host's session survives; the guest's participation row is gone.
    assert.notEqual(h.repo.sessions.byId("sess_01"), null);
    const ps = h.repo.participants.listForSession("sess_01");
    assert.deepEqual(
      ps.map((p) => p.handle),
      ["@host.bot"],
    );
  });
});

describe("AgentsRepo — allowlist", () => {
  beforeEach(() => {
    h.repo.agents.register({ handle: "@me.bot", bearerTokenHash: "x".repeat(64) });
  });

  it("adds idempotently", () => {
    h.repo.agents.addAllowlistEntry("@me.bot", "@friend.bot");
    h.repo.agents.addAllowlistEntry("@me.bot", "@friend.bot"); // dup
    h.repo.agents.addAllowlistEntry("@me.bot", "@trusted.*");
    const list = h.repo.agents.listAllowlist("@me.bot");
    assert.deepEqual(list.map((e) => e.entry), ["@friend.bot", "@trusted.*"]);
  });

  it("removes entries", () => {
    h.repo.agents.addAllowlistEntry("@me.bot", "@friend.bot");
    assert.equal(h.repo.agents.removeAllowlistEntry("@me.bot", "@friend.bot"), true);
    assert.equal(h.repo.agents.removeAllowlistEntry("@me.bot", "@friend.bot"), false);
  });

  it("cascades on agent delete", () => {
    h.repo.agents.addAllowlistEntry("@me.bot", "@friend.bot");
    h.repo.agents.remove("@me.bot");
    // Re-register to verify the previous allowlist rows are gone.
    h.repo.agents.register({ handle: "@me.bot", bearerTokenHash: "x".repeat(64) });
    assert.equal(h.repo.agents.listAllowlist("@me.bot").length, 0);
  });
});

describe("SessionsRepo", () => {
  beforeEach(() => {
    h.repo.agents.register({ handle: "@creator.bot", bearerTokenHash: "h".repeat(64) });
  });

  it("creates and reads sessions, defaults to active state", () => {
    const s = h.repo.sessions.create({
      id: "sess_01",
      creatorHandle: "@creator.bot",
      topic: "about-the-thing",
    });
    assert.equal(s.state, "active");
    assert.equal(s.topic, "about-the-thing");
    assert.deepEqual(h.repo.sessions.byId("sess_01"), s);
  });

  it("transitions active → ended (sets ended_at_ms)", () => {
    h.repo.sessions.create({ id: "sess_01", creatorHandle: "@creator.bot" });
    assert.equal(h.repo.sessions.setState("sess_01", "ended"), true);
    const s = h.repo.sessions.byId("sess_01");
    assert.equal(s?.state, "ended");
    assert.notEqual(s?.endedAtMs, null);
  });

  it("allocates monotonic per-session sequences", () => {
    h.repo.sessions.create({ id: "sess_01", creatorHandle: "@creator.bot" });
    h.repo.sessions.create({ id: "sess_02", creatorHandle: "@creator.bot" });
    const seqs1 = [
      h.repo.sessions.allocateSequence("sess_01"),
      h.repo.sessions.allocateSequence("sess_01"),
      h.repo.sessions.allocateSequence("sess_01"),
    ];
    const seqs2 = [
      h.repo.sessions.allocateSequence("sess_02"),
      h.repo.sessions.allocateSequence("sess_02"),
    ];
    assert.deepEqual(seqs1, [1, 2, 3]);
    assert.deepEqual(seqs2, [1, 2]);
  });

  it("allocateSequence on an unknown session throws", () => {
    assert.throws(() => h.repo.sessions.allocateSequence("missing"));
  });
});

describe("ParticipantsRepo", () => {
  beforeEach(() => {
    h.repo.agents.register({ handle: "@creator.bot", bearerTokenHash: "h".repeat(64) });
    h.repo.sessions.create({ id: "sess_01", creatorHandle: "@creator.bot" });
  });

  it("adds and updates participant status, preserving joined_at on later transitions", () => {
    h.repo.participants.add("sess_01", "@friend.bot", "invited");
    let p = h.repo.participants.get("sess_01", "@friend.bot");
    assert.equal(p?.status, "invited");
    assert.equal(p?.joinedAtMs, null);

    h.repo.participants.setStatus("sess_01", "@friend.bot", "joined");
    p = h.repo.participants.get("sess_01", "@friend.bot");
    assert.equal(p?.status, "joined");
    assert.notEqual(p?.joinedAtMs, null);
    const firstJoined = p?.joinedAtMs;

    // re-joining (e.g. after a left) does NOT reset joined_at_ms — invariant
    // we rely on for participant timeline reconstruction.
    h.repo.participants.setStatus("sess_01", "@friend.bot", "left");
    h.repo.participants.setStatus("sess_01", "@friend.bot", "joined");
    p = h.repo.participants.get("sess_01", "@friend.bot");
    assert.equal(p?.joinedAtMs, firstJoined);
  });

  it("listForSession and listForHandle read the right slices", () => {
    h.repo.participants.add("sess_01", "@a.bot", "joined");
    h.repo.participants.add("sess_01", "@b.bot", "invited");
    h.repo.sessions.create({ id: "sess_02", creatorHandle: "@creator.bot" });
    h.repo.participants.add("sess_02", "@a.bot", "joined");

    const inSession = h.repo.participants.listForSession("sess_01");
    assert.deepEqual(inSession.map((p) => p.handle), ["@a.bot", "@b.bot"]);

    const forHandle = h.repo.participants.listForHandle("@a.bot");
    assert.deepEqual(
      forHandle.map((p) => p.sessionId).sort(),
      ["sess_01", "sess_02"],
    );
  });
});

describe("EventsRepo + DeliveryCursorsRepo", () => {
  beforeEach(() => {
    h.repo.agents.register({ handle: "@creator.bot", bearerTokenHash: "h".repeat(64) });
    h.repo.sessions.create({ id: "sess_01", creatorHandle: "@creator.bot" });
  });

  it("appends events with caller-allocated sequences and reads them back in order", () => {
    const seq1 = h.repo.sessions.allocateSequence("sess_01");
    h.repo.events.append({
      id: "evt_01",
      sessionId: "sess_01",
      sequence: seq1,
      type: "session.invited",
      payload: { invitee: "@x.bot", by: "@creator.bot" },
    });
    const seq2 = h.repo.sessions.allocateSequence("sess_01");
    h.repo.events.append({
      id: "evt_02",
      sessionId: "sess_01",
      sequence: seq2,
      type: "session.joined",
      payload: { agent: "@x.bot" },
    });

    const after0 = h.repo.events.listForSessionAfter("sess_01", 0, 100);
    assert.equal(after0.length, 2);
    assert.equal(after0[0].sequence, 1);
    assert.equal(after0[1].sequence, 2);
    assert.deepEqual(after0[0].payload, {
      invitee: "@x.bot",
      by: "@creator.bot",
    });

    const afterFirst = h.repo.events.listForSessionAfter("sess_01", 1, 100);
    assert.equal(afterFirst.length, 1);
    assert.equal(afterFirst[0].id, "evt_02");
  });

  it("rejects duplicate (session_id, sequence) pairs via UNIQUE", () => {
    h.repo.events.append({
      id: "evt_01",
      sessionId: "sess_01",
      sequence: 1,
      type: "session.invited",
      payload: { invitee: "@x.bot" },
    });
    assert.throws(
      () =>
        h.repo.events.append({
          id: "evt_02",
          sessionId: "sess_01",
          sequence: 1,
          type: "session.joined",
          payload: { agent: "@x.bot" },
        }),
      /UNIQUE/,
    );
  });

  it("delivery cursors only advance forward, monotonically", () => {
    h.repo.cursors.advance("@x.bot", "sess_01", 3);
    h.repo.cursors.advance("@x.bot", "sess_01", 5);
    h.repo.cursors.advance("@x.bot", "sess_01", 4); // out-of-order, ignored
    assert.equal(h.repo.cursors.get("@x.bot", "sess_01"), 5);
    assert.equal(h.repo.cursors.get("@y.bot", "sess_01"), 0);
  });
});

describe("MessagesRepo", () => {
  beforeEach(() => {
    h.repo.agents.register({ handle: "@creator.bot", bearerTokenHash: "h".repeat(64) });
    h.repo.sessions.create({ id: "sess_01", creatorHandle: "@creator.bot" });
  });

  it("round-trips arbitrary content + metadata", () => {
    const seq = h.repo.sessions.allocateSequence("sess_01");
    const msg = h.repo.messages.insert({
      id: "msg_01",
      sessionId: "sess_01",
      senderHandle: "@creator.bot",
      sequence: seq,
      content: [{ type: "text", text: "hi" }],
      metadata: { trace_id: "t-123" },
    });
    assert.deepEqual(msg.content, [{ type: "text", text: "hi" }]);
    assert.deepEqual(msg.metadata, { trace_id: "t-123" });

    const got = h.repo.messages.byId("msg_01");
    assert.deepEqual(got, msg);
  });
});

describe("IdempotencyRepo", () => {
  beforeEach(() => {
    h.repo.agents.register({ handle: "@creator.bot", bearerTokenHash: "h".repeat(64) });
    h.repo.sessions.create({ id: "sess_01", creatorHandle: "@creator.bot" });
  });

  it("returns null for unknown keys, then the stored record after recording", () => {
    assert.equal(h.repo.idempotency.lookup("sess_01", "@creator.bot", "k1"), null);
    const rec = h.repo.idempotency.record({
      sessionId: "sess_01",
      senderHandle: "@creator.bot",
      key: "k1",
      messageId: "msg_xyz",
      sequence: 7,
    });
    assert.equal(rec.messageId, "msg_xyz");
    assert.equal(rec.sequence, 7);

    const got = h.repo.idempotency.lookup("sess_01", "@creator.bot", "k1");
    assert.deepEqual(got, rec);
  });
});

describe("transactional integrity", () => {
  it("wrapping inserts in db.transaction rolls back on throw", () => {
    h.repo.agents.register({ handle: "@creator.bot", bearerTokenHash: "h".repeat(64) });
    h.repo.sessions.create({ id: "sess_01", creatorHandle: "@creator.bot" });

    const txn = h.db.transaction(() => {
      const seq = h.repo.sessions.allocateSequence("sess_01");
      h.repo.events.append({
        id: "evt_x",
        sessionId: "sess_01",
        sequence: seq,
        type: "session.invited",
        payload: {},
      });
      throw new Error("boom");
    });
    assert.throws(() => txn(), /boom/);
    // Sequence allocation was rolled back too; the next allocation still returns 1.
    const seq = h.repo.sessions.allocateSequence("sess_01");
    assert.equal(seq, 1);
    assert.equal(h.repo.events.listForSessionAfter("sess_01", 0, 100).length, 0);
  });
});
