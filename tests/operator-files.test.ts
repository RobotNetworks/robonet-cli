import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import type { DatabaseSync } from "node:sqlite";

import type { OperatorConfig } from "../src/operator/config.js";
import { startOperatorServer, type OperatorHandle } from "../src/operator/server.js";
import { openOperatorDatabase } from "../src/operator/storage/database.js";
import { OperatorRepository } from "../src/operator/storage/repository.js";
import { sha256Hex } from "../src/operator/tokens.js";

interface Harness {
  readonly baseUrl: string;
  readonly handle: OperatorHandle;
  readonly db: DatabaseSync;
  readonly repo: OperatorRepository;
  readonly adminToken: string;
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

async function makeHarness(): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "robotnet-op-files-"));
  const dbPath = path.join(dir, "operator.sqlite");
  const filesDir = path.join(dir, "files");
  fs.mkdirSync(filesDir, { recursive: true });
  const port = await pickPort();
  const adminToken = "admin_" + Math.random().toString(36).slice(2);
  const config: OperatorConfig = {
    networkName: "local",
    host: "127.0.0.1",
    port,
    databasePath: dbPath,
    filesDir,
    adminTokenHash: sha256Hex(adminToken),
    operatorVersion: "0.0.0-test",
  };
  const db = openOperatorDatabase(dbPath);
  const repo = new OperatorRepository(db);
  const handle = await startOperatorServer({ config, db, repo });
  return {
    baseUrl: `http://${handle.host}:${handle.port}`,
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

async function adminRegister(
  h: Harness,
  handle: string,
  opts: {
    readonly policy?: "open" | "allowlist";
    readonly allowlistEntries?: readonly string[];
  } = {},
): Promise<string> {
  // Mirror the operator-sessions harness: default to `policy: "open"`
  // so the symmetric allowlist check (Whitepaper §6.2) does not
  // accidentally deny inviters who aren't the focus of the test.
  const policy = opts.policy ?? "open";
  const reg = await fetch(`${h.baseUrl}/_admin/agents`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${h.adminToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ handle, policy }),
  });
  if (reg.status !== 201) {
    throw new Error(`register failed: ${reg.status} ${await reg.text()}`);
  }
  const created = (await reg.json()) as { token: string };
  h.tokens.set(handle, created.token);
  if (opts.allowlistEntries !== undefined && opts.allowlistEntries.length > 0) {
    const al = await fetch(`${h.baseUrl}/agents/me/allowlist`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${created.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ entries: opts.allowlistEntries }),
    });
    if (al.status !== 200) {
      throw new Error(`allowlist add failed: ${al.status}`);
    }
  }
  return created.token;
}

function tokenHeader(h: Harness, handle: string): string {
  const t = h.tokens.get(handle);
  if (t === undefined) throw new Error(`no token for ${handle}`);
  return `Bearer ${t}`;
}

async function uploadPng1x1(
  h: Harness,
  uploaderHandle: string,
  filename = "tiny.png",
): Promise<{ id: string; sizeBytes: number; bytes: Buffer }> {
  // 1x1 transparent PNG.
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
    "base64",
  );
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "image/png" }), filename);
  const res = await fetch(`${h.baseUrl}/files`, {
    method: "POST",
    headers: { Authorization: tokenHeader(h, uploaderHandle) },
    body: form,
  });
  if (res.status !== 201) {
    throw new Error(`upload failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { id: string; size_bytes: number };
  return { id: body.id, sizeBytes: body.size_bytes, bytes };
}

describe("operator files — upload + download", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it("POST /files mints a pending file and returns metadata", async () => {
    await adminRegister(h, "@alice.bot");
    const result = await uploadPng1x1(h, "@alice.bot");
    assert.match(result.id, /^file_[0-9A-Z]+$/);
    const row = h.repo.files.byId(result.id);
    assert.notEqual(row, null);
    assert.equal(row!.uploaderHandle, "@alice.bot");
    assert.equal(row!.status, "pending");
    assert.equal(row!.contentType, "image/png");
    assert.equal(row!.sizeBytes, result.bytes.length);
  });

  it("POST /files rejects content-type spoofing via magic-byte check", async () => {
    await adminRegister(h, "@alice.bot");
    const form = new FormData();
    form.append(
      "file",
      new Blob([Buffer.from("plain text not actually a png")], {
        type: "image/png",
      }),
      "lying.png",
    );
    const res = await fetch(`${h.baseUrl}/files`, {
      method: "POST",
      headers: { Authorization: tokenHeader(h, "@alice.bot") },
      body: form,
    });
    assert.equal(res.status, 400);
    const err = (await res.json()) as { error?: { code?: string } };
    assert.equal(err.error?.code, "INVALID_FILE");
  });

  it("POST /files rejects an empty file", async () => {
    await adminRegister(h, "@alice.bot");
    const form = new FormData();
    form.append(
      "file",
      new Blob([Buffer.alloc(0)], { type: "text/plain" }),
      "empty.txt",
    );
    const res = await fetch(`${h.baseUrl}/files`, {
      method: "POST",
      headers: { Authorization: tokenHeader(h, "@alice.bot") },
      body: form,
    });
    assert.equal(res.status, 400);
  });

  it("GET /files/:id while pending: visible to uploader, 404 to others", async () => {
    await adminRegister(h, "@alice.bot");
    await adminRegister(h, "@bob.bot");
    const upload = await uploadPng1x1(h, "@alice.bot");

    const ownerRes = await fetch(`${h.baseUrl}/files/${upload.id}`, {
      headers: { Authorization: tokenHeader(h, "@alice.bot") },
    });
    assert.equal(ownerRes.status, 200);
    assert.equal(ownerRes.headers.get("content-type"), "image/png");
    const downloaded = Buffer.from(await ownerRes.arrayBuffer());
    assert.equal(downloaded.length, upload.sizeBytes);
    assert.deepEqual(downloaded, upload.bytes);

    const otherRes = await fetch(`${h.baseUrl}/files/${upload.id}`, {
      headers: { Authorization: tokenHeader(h, "@bob.bot") },
    });
    assert.equal(otherRes.status, 404);
  });

  it("session send with file_id rewrites to url, claims, and is downloadable by participants", async () => {
    await adminRegister(h, "@alice.bot");
    await adminRegister(h, "@bob.bot", {
      policy: "allowlist",
      allowlistEntries: ["@alice.bot"],
    });
    const upload = await uploadPng1x1(h, "@alice.bot");

    // Create session and have bob join so he's eligible for messages.
    const create = await fetch(`${h.baseUrl}/sessions`, {
      method: "POST",
      headers: {
        Authorization: tokenHeader(h, "@alice.bot"),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ invite: ["@bob.bot"] }),
    });
    const { session_id } = (await create.json()) as { session_id: string };
    await fetch(`${h.baseUrl}/sessions/${session_id}/join`, {
      method: "POST",
      headers: { Authorization: tokenHeader(h, "@bob.bot") },
    });

    // Send a multipart message: text + file_id.
    const send = await fetch(`${h.baseUrl}/sessions/${session_id}/messages`, {
      method: "POST",
      headers: {
        Authorization: tokenHeader(h, "@alice.bot"),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content: [
          { type: "text", text: "see attached" },
          { type: "file", file_id: upload.id },
        ],
      }),
    });
    assert.equal(send.status, 201);

    // The persisted file row is now ATTACHED to the message.
    const claimed = h.repo.files.byId(upload.id);
    assert.equal(claimed!.status, "attached");
    assert.notEqual(claimed!.sessionMessageId, null);

    // The events transcript carries the content exactly as the
    // sender supplied it — file_id is preserved, no url substitution.
    // Receivers call GET /files/{file_id} to mint a fresh URL on demand.
    const events = await fetch(
      `${h.baseUrl}/sessions/${session_id}/events?after_sequence=0&limit=10`,
      { headers: { Authorization: tokenHeader(h, "@alice.bot") } },
    );
    const eventsBody = (await events.json()) as {
      events: Array<{ type: string; payload: { content: unknown } }>;
    };
    const messageEvent = eventsBody.events.find((e) => e.type === "session.message");
    assert.notEqual(messageEvent, undefined);
    const content = messageEvent!.payload.content as Array<Record<string, unknown>>;
    assert.equal(content.length, 2);
    assert.equal(content[1]!.type, "file");
    assert.equal(content[1]!.file_id, upload.id);
    assert.equal(content[1]!.url, undefined);

    // Bob (joined participant) can download.
    const bobDownload = await fetch(`${h.baseUrl}/files/${upload.id}`, {
      headers: { Authorization: tokenHeader(h, "@bob.bot") },
    });
    assert.equal(bobDownload.status, 200);
    const bobBytes = Buffer.from(await bobDownload.arrayBuffer());
    assert.deepEqual(bobBytes, upload.bytes);
  });

  it("session send with file_id owned by another agent → 404", async () => {
    await adminRegister(h, "@alice.bot");
    await adminRegister(h, "@eve.bot");
    const eveUpload = await uploadPng1x1(h, "@eve.bot");

    const create = await fetch(`${h.baseUrl}/sessions`, {
      method: "POST",
      headers: {
        Authorization: tokenHeader(h, "@alice.bot"),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ invite: [] }),
    });
    const { session_id } = (await create.json()) as { session_id: string };

    const send = await fetch(`${h.baseUrl}/sessions/${session_id}/messages`, {
      method: "POST",
      headers: {
        Authorization: tokenHeader(h, "@alice.bot"),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content: [{ type: "file", file_id: eveUpload.id }],
      }),
    });
    assert.equal(send.status, 404);

    // Eve's pending file remains untouched.
    const row = h.repo.files.byId(eveUpload.id);
    assert.equal(row!.status, "pending");
    assert.equal(row!.sessionMessageId, null);
  });

  it("idempotency replay does not re-claim files", async () => {
    await adminRegister(h, "@alice.bot");
    const upload = await uploadPng1x1(h, "@alice.bot");

    const create = await fetch(`${h.baseUrl}/sessions`, {
      method: "POST",
      headers: {
        Authorization: tokenHeader(h, "@alice.bot"),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ invite: [] }),
    });
    const { session_id } = (await create.json()) as { session_id: string };

    const body = {
      content: [{ type: "file", file_id: upload.id }],
      idempotency_key: "k1",
    };
    const send1 = await fetch(`${h.baseUrl}/sessions/${session_id}/messages`, {
      method: "POST",
      headers: {
        Authorization: tokenHeader(h, "@alice.bot"),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    assert.equal(send1.status, 201);
    const r1 = (await send1.json()) as { message_id: string; sequence: number };

    // Replay the same body with the same key — second call must NOT
    // try to re-claim (the file is now ``attached``, so a re-claim
    // attempt would 404). Same (message_id, sequence) returned.
    const send2 = await fetch(`${h.baseUrl}/sessions/${session_id}/messages`, {
      method: "POST",
      headers: {
        Authorization: tokenHeader(h, "@alice.bot"),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    assert.equal(send2.status, 201);
    const r2 = (await send2.json()) as { message_id: string; sequence: number };
    assert.equal(r2.message_id, r1.message_id);
    assert.equal(r2.sequence, r1.sequence);

    // File still attached, claimed once.
    const row = h.repo.files.byId(upload.id);
    assert.equal(row!.status, "attached");
  });
});
