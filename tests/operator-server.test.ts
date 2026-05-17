import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import type { DatabaseSync } from "node:sqlite";

import type { OperatorConfig } from "../src/operator/config.js";
import {
  startOperatorServer,
  type OperatorHandle,
} from "../src/operator/server.js";
import { openOperatorDatabase } from "../src/operator/storage/database.js";
import { OperatorRepository } from "../src/operator/storage/repository.js";
import { sha256Hex } from "../src/operator/tokens.js";

interface Harness {
  readonly baseUrl: string;
  readonly handle: OperatorHandle;
  readonly db: DatabaseSync;
  readonly repo: OperatorRepository;
  readonly dataDir: string;
  readonly adminToken: string;
  readonly close: () => Promise<void>;
}

const PORTS = (function* (): IterableIterator<number> {
  let next = 9001;
  while (true) yield next++;
})();

async function pickFreePort(): Promise<number> {
  for (let tries = 0; tries < 64; tries++) {
    const candidate = PORTS.next().value as number;
    const free = await new Promise<boolean>((resolve) => {
      const sock = net.createServer();
      sock.once("error", () => resolve(false));
      sock.once("listening", () => {
        sock.close(() => resolve(true));
      });
      sock.listen(candidate, "127.0.0.1");
    });
    if (free) return candidate;
  }
  throw new Error("could not find a free port for the operator test");
}

async function makeHarness(): Promise<Harness> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "robotnet-op-test-"));
  const dbPath = path.join(dataDir, "operator.sqlite");
  const filesDir = path.join(dataDir, "files");
  fs.mkdirSync(filesDir, { recursive: true });
  const port = await pickFreePort();
  const adminToken = "admin-test-token";
  const config: OperatorConfig = {
    networkName: "test",
    host: "127.0.0.1",
    port,
    databasePath: dbPath,
    filesDir,
    adminTokenHash: sha256Hex(adminToken),
    operatorVersion: "test",
  };
  const db = openOperatorDatabase(config.databasePath);
  const repo = new OperatorRepository(db);
  const handle = await startOperatorServer({ config, db, repo });
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    handle,
    db,
    repo,
    dataDir,
    adminToken,
    close: async () => {
      await handle.close();
      db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

interface RegisteredAgent {
  readonly handle: string;
  readonly token: string;
}

async function registerAgent(
  harness: Harness,
  handle: string,
  opts: { readonly policy?: "open" | "allowlist" } = {},
): Promise<RegisteredAgent> {
  const res = await fetch(`${harness.baseUrl}/_admin/agents`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${harness.adminToken}`,
      "Content-Type": "application/json",
      "Idempotency-Key": handle,
    },
    body: JSON.stringify({
      handle,
      policy: opts.policy ?? "open",
    }),
  });
  if (!res.ok) {
    throw new Error(`register ${handle} failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { token: string };
  return { handle, token: body.token };
}

let h: Harness;

beforeEach(async () => {
  h = await makeHarness();
});

afterEach(async () => {
  await h.close();
});

const ENVELOPE_TEXT_BODY = (id: string, to: string[]): Record<string, unknown> => ({
  id,
  to,
  date_ms: 1747000000000,
  content_parts: [{ type: "text", text: "hello there" }],
});

describe("operator POST /messages + GET /mailbox + GET /messages/{id}", () => {
  it("accepts an envelope and surfaces it in the recipient's mailbox", async () => {
    const alice = await registerAgent(h, "@alice.cli");
    const bob = await registerAgent(h, "@bob.cli");

    const envelopeId = "01HW7Z9KQX1MS2D9P5VC3GZ8AB";
    const sendRes = await fetch(`${h.baseUrl}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${alice.token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "send-1",
      },
      body: JSON.stringify(ENVELOPE_TEXT_BODY(envelopeId, [bob.handle])),
    });
    assert.equal(sendRes.status, 202);
    const sendBody = (await sendRes.json()) as {
      id: string;
      created_at: number;
      recipients: { handle: string }[];
    };
    assert.equal(sendBody.id, envelopeId);
    assert.ok(sendBody.created_at > 0);
    assert.deepEqual(sendBody.recipients, [{ handle: bob.handle }]);

    // Bob lists his mailbox; the header is there.
    const mailboxRes = await fetch(`${h.baseUrl}/mailbox?order=asc`, {
      headers: { Authorization: `Bearer ${bob.token}` },
    });
    assert.equal(mailboxRes.status, 200);
    const mailboxBody = (await mailboxRes.json()) as {
      envelope_headers: { id: string; from: string; type_hint: string }[];
      next_cursor: unknown;
    };
    assert.equal(mailboxBody.envelope_headers.length, 1);
    assert.equal(mailboxBody.envelope_headers[0]!.id, envelopeId);
    assert.equal(mailboxBody.envelope_headers[0]!.from, alice.handle);
    assert.equal(mailboxBody.envelope_headers[0]!.type_hint, "text");

    // Bob fetches the body; the envelope JSON includes the operator-
    // stamped `from` and the full content_parts.
    const fetchRes = await fetch(`${h.baseUrl}/messages/${envelopeId}`, {
      headers: { Authorization: `Bearer ${bob.token}` },
    });
    assert.equal(fetchRes.status, 200);
    const fetchBody = (await fetchRes.json()) as {
      from: string;
      content_parts: { type: string; text?: string }[];
    };
    assert.equal(fetchBody.from, alice.handle);
    assert.equal(fetchBody.content_parts[0]!.text, "hello there");
  });

  it("allows an agent to send to itself even under allowlist policy", async () => {
    // Self-trust: an agent addressing its own mailbox bypasses the
    // bilateral allowlist gate (mirrors email's To/Cc-yourself). Without
    // this, an allowlist-policy agent would have to put itself on its
    // own allowlist before sending to itself.
    const alice = await registerAgent(h, "@alice.cli", { policy: "allowlist" });

    const envelopeId = "01HW7Z9KQX1MS2D9P5VC3GZ8SE";
    const sendRes = await fetch(`${h.baseUrl}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${alice.token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "self-send-1",
      },
      body: JSON.stringify(ENVELOPE_TEXT_BODY(envelopeId, [alice.handle])),
    });
    assert.equal(sendRes.status, 202);

    // Alice's own mailbox now contains the envelope.
    const mailboxRes = await fetch(`${h.baseUrl}/mailbox?order=asc`, {
      headers: { Authorization: `Bearer ${alice.token}` },
    });
    assert.equal(mailboxRes.status, 200);
    const mailboxBody = (await mailboxRes.json()) as {
      envelope_headers: { id: string; from: string }[];
    };
    assert.equal(mailboxBody.envelope_headers.length, 1);
    assert.equal(mailboxBody.envelope_headers[0]!.id, envelopeId);
    assert.equal(mailboxBody.envelope_headers[0]!.from, alice.handle);
  });

  it("a non-recipient gets 404 on GET /messages/{id}", async () => {
    const alice = await registerAgent(h, "@alice.cli");
    const bob = await registerAgent(h, "@bob.cli");
    const carol = await registerAgent(h, "@carol.cli");

    const envelopeId = "01HW7Z9KQX1MS2D9P5VC3GZ8AB";
    await fetch(`${h.baseUrl}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${alice.token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "send-1",
      },
      body: JSON.stringify(ENVELOPE_TEXT_BODY(envelopeId, [bob.handle])),
    });
    const fetchRes = await fetch(`${h.baseUrl}/messages/${envelopeId}`, {
      headers: { Authorization: `Bearer ${carol.token}` },
    });
    assert.equal(fetchRes.status, 404);
  });

  it("POST /mailbox/read flips read=true for entitled ids and silently drops others", async () => {
    const alice = await registerAgent(h, "@alice.cli");
    const bob = await registerAgent(h, "@bob.cli");

    const envelopeId = "01HW7Z9KQX1MS2D9P5VC3GZ8AB";
    await fetch(`${h.baseUrl}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${alice.token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "send-1",
      },
      body: JSON.stringify(ENVELOPE_TEXT_BODY(envelopeId, [bob.handle])),
    });
    const res = await fetch(`${h.baseUrl}/mailbox/read`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bob.token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "read-1",
      },
      body: JSON.stringify({
        ids: [envelopeId, "01HW7Z9KQX1MS2D9P5VC3GZ8AC" /* not owned */],
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { read: string[] };
    assert.deepEqual(body.read, [envelopeId]);

    // Mailbox listing with unread=true now omits the read envelope.
    const unreadRes = await fetch(`${h.baseUrl}/mailbox?unread=true`, {
      headers: { Authorization: `Bearer ${bob.token}` },
    });
    const unread = (await unreadRes.json()) as {
      envelope_headers: { id: string }[];
    };
    assert.equal(unread.envelope_headers.length, 0);
  });

  it("GET /messages?ids=... batch-fetches and returns in input order", async () => {
    const alice = await registerAgent(h, "@alice.cli");
    const bob = await registerAgent(h, "@bob.cli");

    const ids = [
      "01HW7Z9KQX1MS2D9P5VC3GZ8AB",
      "01HW7Z9KQX1MS2D9P5VC3GZ8AC",
    ];
    for (const id of ids) {
      const r = await fetch(`${h.baseUrl}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alice.token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": `send-${id}`,
        },
        body: JSON.stringify(ENVELOPE_TEXT_BODY(id, [bob.handle])),
      });
      assert.equal(r.status, 202);
    }
    // Reverse the request order; the response must respect input order.
    const fetchRes = await fetch(
      `${h.baseUrl}/messages?ids=${ids[1]},${ids[0]}`,
      { headers: { Authorization: `Bearer ${bob.token}` } },
    );
    assert.equal(fetchRes.status, 200);
    const body = (await fetchRes.json()) as { envelopes: { id: string }[] };
    assert.deepEqual(
      body.envelopes.map((e) => e.id),
      [ids[1], ids[0]],
    );
  });

  it("desc order returns newest first; asc returns oldest first", async () => {
    const alice = await registerAgent(h, "@alice.cli");
    const bob = await registerAgent(h, "@bob.cli");

    const ids = [
      "01HW7Z9KQX1MS2D9P5VC3GZ8AB",
      "01HW7Z9KQX1MS2D9P5VC3GZ8AC",
    ];
    for (const id of ids) {
      await fetch(`${h.baseUrl}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alice.token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": `send-${id}`,
        },
        body: JSON.stringify(ENVELOPE_TEXT_BODY(id, [bob.handle])),
      });
      // small delay so created_at differs between rows
      await new Promise((r) => setTimeout(r, 2));
    }
    const ascRes = await fetch(`${h.baseUrl}/mailbox?order=asc`, {
      headers: { Authorization: `Bearer ${bob.token}` },
    });
    const asc = (await ascRes.json()) as {
      envelope_headers: { id: string }[];
    };
    const descRes = await fetch(`${h.baseUrl}/mailbox?order=desc`, {
      headers: { Authorization: `Bearer ${bob.token}` },
    });
    const desc = (await descRes.json()) as {
      envelope_headers: { id: string }[];
    };
    assert.deepEqual(
      asc.envelope_headers.map((h) => h.id),
      ids,
    );
    assert.deepEqual(
      desc.envelope_headers.map((h) => h.id),
      [...ids].reverse(),
    );
  });

  it("blocks an envelope when the recipient blocked the sender (non-enumerating 404)", async () => {
    const alice = await registerAgent(h, "@alice.cli");
    const bob = await registerAgent(h, "@bob.cli");

    // Bob blocks alice.
    const blockRes = await fetch(`${h.baseUrl}/agents/me/blocks`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bob.token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "block-1",
      },
      body: JSON.stringify({ handle: alice.handle }),
    });
    assert.equal(blockRes.status, 201);

    const sendRes = await fetch(`${h.baseUrl}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${alice.token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "send-1",
      },
      body: JSON.stringify(
        ENVELOPE_TEXT_BODY("01HW7Z9KQX1MS2D9P5VC3GZ8AB", [bob.handle]),
      ),
    });
    assert.equal(sendRes.status, 404);
  });

  it("delivers an envelope to both `to` and `cc` recipients and echoes cc on fetch", async () => {
    const alice = await registerAgent(h, "@alice.cli");
    const bob = await registerAgent(h, "@bob.cli");
    const carol = await registerAgent(h, "@carol.cli");

    const envelopeId = "01HW7Z9KQX1MS2D9P5VC3GZCC0";
    const sendRes = await fetch(`${h.baseUrl}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${alice.token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "cc-send-1",
      },
      body: JSON.stringify({
        ...ENVELOPE_TEXT_BODY(envelopeId, [bob.handle]),
        cc: [carol.handle],
      }),
    });
    assert.equal(sendRes.status, 202);
    const sendBody = (await sendRes.json()) as {
      recipients: { handle: string }[];
    };
    // All-or-nothing: both bob and carol get accepted in one call.
    const accepted = sendBody.recipients.map((r) => r.handle).sort();
    assert.deepEqual(accepted, [bob.handle, carol.handle].sort());

    // Both recipients see the envelope in their mailbox with the same id.
    for (const recipient of [bob, carol]) {
      const mailboxRes = await fetch(`${h.baseUrl}/mailbox?order=asc`, {
        headers: { Authorization: `Bearer ${recipient.token}` },
      });
      const body = (await mailboxRes.json()) as {
        envelope_headers: { id: string; from: string; cc?: string[] }[];
      };
      assert.equal(body.envelope_headers.length, 1);
      assert.equal(body.envelope_headers[0]!.id, envelopeId);
      assert.deepEqual(body.envelope_headers[0]!.cc, [carol.handle]);

      const fetchRes = await fetch(`${h.baseUrl}/messages/${envelopeId}`, {
        headers: { Authorization: `Bearer ${recipient.token}` },
      });
      assert.equal(fetchRes.status, 200);
      const fetched = (await fetchRes.json()) as {
        from: string;
        to: string[];
        cc: string[];
      };
      assert.equal(fetched.from, alice.handle);
      assert.deepEqual(fetched.to, [bob.handle]);
      assert.deepEqual(fetched.cc, [carol.handle]);
    }
  });

  it("rejects client-supplied `from` on POST /messages with 400", async () => {
    const alice = await registerAgent(h, "@alice.cli");
    const bob = await registerAgent(h, "@bob.cli");

    const sendRes = await fetch(`${h.baseUrl}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${alice.token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "send-1",
      },
      body: JSON.stringify({
        ...ENVELOPE_TEXT_BODY("01HW7Z9KQX1MS2D9P5VC3GZ8AB", [bob.handle]),
        from: "@fake.bot",
      }),
    });
    assert.equal(sendRes.status, 400);
  });

  it("GET /search/messages returns hits the caller is on; non-recipients see zero", async () => {
    const alice = await registerAgent(h, "@alice.cli");
    const bob = await registerAgent(h, "@bob.cli");
    const carol = await registerAgent(h, "@carol.cli");

    // Three envelopes from Alice to Bob with distinct text bodies.
    const ids = [
      "01HW7Z9KQX1MS2D9P5VC3GZ800",
      "01HW7Z9KQX1MS2D9P5VC3GZ801",
      "01HW7Z9KQX1MS2D9P5VC3GZ802",
    ];
    const texts = ["build is green", "deploy failed loudly", "midnight nudge"];
    for (let i = 0; i < ids.length; i++) {
      const res = await fetch(`${h.baseUrl}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alice.token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": `send-${i}`,
        },
        body: JSON.stringify({
          id: ids[i],
          to: [bob.handle],
          date_ms: 1747000000000 + i,
          content_parts: [{ type: "text", text: texts[i] }],
        }),
      });
      assert.equal(res.status, 202);
    }

    // Bob searches for "deploy" — one hit, his own envelope.
    const bobSearch = await fetch(
      `${h.baseUrl}/search/messages?q=${encodeURIComponent("deploy")}&limit=10`,
      { headers: { Authorization: `Bearer ${bob.token}` } },
    );
    assert.equal(bobSearch.status, 200);
    const bobBody = (await bobSearch.json()) as {
      envelopes: {
        envelope_id: string;
        sender_handle: string;
        recipient_handles: string[];
        subject: string | null;
        snippet: string | null;
        created_at: number;
        date_ms: number;
      }[];
    };
    assert.equal(bobBody.envelopes.length, 1);
    assert.equal(bobBody.envelopes[0]!.envelope_id, ids[1]);
    assert.equal(bobBody.envelopes[0]!.sender_handle, alice.handle);
    assert.deepEqual(bobBody.envelopes[0]!.recipient_handles, [bob.handle]);

    // Carol (a non-recipient of every envelope) searches for the same
    // term and MUST get zero results — recipient filter is load-bearing.
    const carolSearch = await fetch(
      `${h.baseUrl}/search/messages?q=${encodeURIComponent("deploy")}&limit=10`,
      { headers: { Authorization: `Bearer ${carol.token}` } },
    );
    assert.equal(carolSearch.status, 200);
    const carolBody = (await carolSearch.json()) as { envelopes: unknown[] };
    assert.equal(
      carolBody.envelopes.length,
      0,
      "search MUST NOT leak envelopes the caller is not a recipient of",
    );
  });

  it("GET /search/messages orders newest-first and caps at limit", async () => {
    const alice = await registerAgent(h, "@alice.cli");
    const bob = await registerAgent(h, "@bob.cli");

    const ids = [
      "01HW7Z9KQX1MS2D9P5VC3GZ810",
      "01HW7Z9KQX1MS2D9P5VC3GZ811",
      "01HW7Z9KQX1MS2D9P5VC3GZ812",
    ];
    for (let i = 0; i < ids.length; i++) {
      await fetch(`${h.baseUrl}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alice.token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": `send-${i}`,
        },
        body: JSON.stringify({
          id: ids[i],
          to: [bob.handle],
          date_ms: 1747000000000 + i,
          content_parts: [{ type: "text", text: "keyword-match" }],
        }),
      });
    }

    const res = await fetch(
      `${h.baseUrl}/search/messages?q=${encodeURIComponent("keyword-match")}&limit=2`,
      { headers: { Authorization: `Bearer ${bob.token}` } },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      envelopes: { envelope_id: string; created_at: number }[];
    };
    assert.equal(body.envelopes.length, 2, "limit MUST cap the page");
    // Newest-first (created_at DESC). The third envelope inserted has the
    // highest created_at, so it leads.
    assert.equal(body.envelopes[0]!.envelope_id, ids[2]);
    assert.equal(body.envelopes[1]!.envelope_id, ids[1]);
    assert.ok(
      body.envelopes[0]!.created_at >= body.envelopes[1]!.created_at,
      "results MUST be ordered newest-first by created_at",
    );
  });

  it("GET /search/messages rejects malformed q with 400", async () => {
    const alice = await registerAgent(h, "@alice.cli");
    // q below minimum length.
    const tooShort = await fetch(`${h.baseUrl}/search/messages?q=a&limit=10`, {
      headers: { Authorization: `Bearer ${alice.token}` },
    });
    assert.equal(tooShort.status, 400);
    // q missing entirely.
    const missing = await fetch(`${h.baseUrl}/search/messages?limit=10`, {
      headers: { Authorization: `Bearer ${alice.token}` },
    });
    assert.equal(missing.status, 400);
  });

  async function uploadPng(
    h: Harness,
    agent: RegisteredAgent,
    idempotencyKey: string,
  ): Promise<string> {
    const boundary = "----WebKitFormBoundary12345";
    const pngHeader = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]);
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from(
        `Content-Disposition: form-data; name="file"; filename="test.png"\r\n`,
      ),
      Buffer.from("Content-Type: image/png\r\n\r\n"),
      pngHeader,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await fetch(`${h.baseUrl}/files`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agent.token}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Idempotency-Key": idempotencyKey,
      },
      body,
    });
    if (res.status !== 201) {
      throw new Error(`upload failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as { id: string };
    return json.id;
  }

  it("recipient of an envelope can download the file by id", async () => {
    // Bilaterally allowlisted so the send isn't refused by trust.
    const alice = await registerAgent(h, "@alice.cli", { policy: "open" });
    const bob = await registerAgent(h, "@bob.cli", { policy: "open" });
    const fileId = await uploadPng(h, alice, "upload-1");

    // Alice sends an envelope to Bob referencing the file by id.
    const envelopeId = "01HW7Z9KQX1MS2D9P5VC3GZ8B1";
    const send = await fetch(`${h.baseUrl}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${alice.token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": envelopeId,
      },
      body: JSON.stringify({
        id: envelopeId,
        to: [bob.handle],
        date_ms: 1_747_000_000_000,
        content_parts: [{ type: "image", file_id: fileId }],
      }),
    });
    assert.equal(send.status, 202);

    // Bob — a party to the envelope but NOT the uploader — fetches
    // the file. Pre-Phase-3 this would 404; post-Phase-3 (the in-tree
    // operator's new auth model) it returns 200 with the bytes.
    const downloadRes = await fetch(`${h.baseUrl}/files/${fileId}`, {
      headers: { Authorization: `Bearer ${bob.token}` },
    });
    assert.equal(downloadRes.status, 200);
  });

  it("non-party agent gets 404 on GET /files/:id", async () => {
    const alice = await registerAgent(h, "@alice.cli", { policy: "open" });
    const bob = await registerAgent(h, "@bob.cli", { policy: "open" });
    const eve = await registerAgent(h, "@eve.cli", { policy: "open" });
    const fileId = await uploadPng(h, alice, "upload-1");

    // Alice sends to Bob; Eve is neither sender, recipient, nor uploader.
    const envelopeId = "01HW7Z9KQX1MS2D9P5VC3GZ8B2";
    await fetch(`${h.baseUrl}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${alice.token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": envelopeId,
      },
      body: JSON.stringify({
        id: envelopeId,
        to: [bob.handle],
        date_ms: 1_747_000_000_000,
        content_parts: [{ type: "image", file_id: fileId }],
      }),
    });

    const res = await fetch(`${h.baseUrl}/files/${fileId}`, {
      headers: { Authorization: `Bearer ${eve.token}` },
    });
    // Non-enumerating: same 404 a missing file produces.
    assert.equal(res.status, 404);
  });

  it("non-uploader on pending file (never attached) gets 404", async () => {
    const alice = await registerAgent(h, "@alice.cli", { policy: "open" });
    const bob = await registerAgent(h, "@bob.cli", { policy: "open" });
    // No envelope claim — file stays pending. Bob is not the uploader.
    const fileId = await uploadPng(h, alice, "upload-1");

    const res = await fetch(`${h.baseUrl}/files/${fileId}`, {
      headers: { Authorization: `Bearer ${bob.token}` },
    });
    assert.equal(res.status, 404);
  });

  it("file_id is single-use: re-sending the same id returns INVALID_FILE", async () => {
    const alice = await registerAgent(h, "@alice.cli", { policy: "open" });
    const bob = await registerAgent(h, "@bob.cli", { policy: "open" });
    const fileId = await uploadPng(h, alice, "upload-1");

    // First send claims the file.
    const first = await fetch(`${h.baseUrl}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${alice.token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "01HW7Z9KQX1MS2D9P5VC3GZ8C1",
      },
      body: JSON.stringify({
        id: "01HW7Z9KQX1MS2D9P5VC3GZ8C1",
        to: [bob.handle],
        date_ms: 1_747_000_000_000,
        content_parts: [{ type: "image", file_id: fileId }],
      }),
    });
    assert.equal(first.status, 202);

    // Second send — DIFFERENT envelope id — referencing the SAME
    // file_id must be refused. Single-use binding.
    const second = await fetch(`${h.baseUrl}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${alice.token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "01HW7Z9KQX1MS2D9P5VC3GZ8C2",
      },
      body: JSON.stringify({
        id: "01HW7Z9KQX1MS2D9P5VC3GZ8C2",
        to: [bob.handle],
        date_ms: 1_747_000_000_001,
        content_parts: [{ type: "image", file_id: fileId }],
      }),
    });
    assert.equal(second.status, 400);
    const body = (await second.json()) as { error: { code: string } };
    assert.equal(body.error.code, "INVALID_FILE");
  });

  it("idempotent replay of a send referencing file_id returns 202 without re-claiming", async () => {
    const alice = await registerAgent(h, "@alice.cli", { policy: "open" });
    const bob = await registerAgent(h, "@bob.cli", { policy: "open" });
    const fileId = await uploadPng(h, alice, "upload-1");

    const envelopeId = "01HW7Z9KQX1MS2D9P5VC3GZ8D1";
    const sendBody = JSON.stringify({
      id: envelopeId,
      to: [bob.handle],
      date_ms: 1_747_000_000_000,
      content_parts: [{ type: "image", file_id: fileId }],
    });
    const sendHeaders = {
      Authorization: `Bearer ${alice.token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": envelopeId,
    };

    const first = await fetch(`${h.baseUrl}/messages`, {
      method: "POST",
      headers: sendHeaders,
      body: sendBody,
    });
    assert.equal(first.status, 202);

    // Same envelope id, same body — must replay to 202 even though the
    // claim() call would refuse on a fresh attempt (single-use). The
    // service's replay branch skips the claim step.
    const replay = await fetch(`${h.baseUrl}/messages`, {
      method: "POST",
      headers: sendHeaders,
      body: sendBody,
    });
    assert.equal(replay.status, 202);
  });

  it("supports POST /files + GET /files/:id round-trip", async () => {
    const alice = await registerAgent(h, "@alice.cli");

    const boundary = "----WebKitFormBoundary12345";
    // A valid PNG header + minimal IHDR-ish bytes; the file service
    // validates magic bytes for png.
    const pngHeader = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]);
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from(
        `Content-Disposition: form-data; name="file"; filename="test.png"\r\n`,
      ),
      Buffer.from("Content-Type: image/png\r\n\r\n"),
      pngHeader,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const uploadRes = await fetch(`${h.baseUrl}/files`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${alice.token}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Idempotency-Key": "upload-1",
      },
      body,
    });
    assert.equal(uploadRes.status, 201);
    const uploadBody = (await uploadRes.json()) as {
      id: string;
      status: string;
      filename: string;
      content_type: string;
      size_bytes: number;
      created_at: number;
      expires_at: number;
    };
    assert.ok(uploadBody.id.startsWith("file_"));
    assert.equal(uploadBody.status, "ready");
    assert.equal(uploadBody.filename, "test.png");
    assert.equal(uploadBody.content_type, "image/png");
    assert.equal(uploadBody.size_bytes, pngHeader.length);
    assert.ok(uploadBody.expires_at > uploadBody.created_at);

    const downloadRes = await fetch(`${h.baseUrl}/files/${uploadBody.id}`, {
      headers: { Authorization: `Bearer ${alice.token}` },
    });
    assert.equal(downloadRes.status, 200);
    const bytes = new Uint8Array(await downloadRes.arrayBuffer());
    assert.equal(bytes.byteLength, pngHeader.length);
  });

  it("filters mailbox by direction (in / out / both / self)", async () => {
    // Regression for the local-operator direction-filter gap: every
    // direction used to return the same recipient feed. Now `out`
    // hits envelopes.from_handle, `both` unions, and self-sends are
    // stamped `self` on the `both` feed.
    const alice = await registerAgent(h, "@alice.cli", { policy: "allowlist" });
    const bob = await registerAgent(h, "@bob.cli", { policy: "allowlist" });
    // Bilateral allowlist so the sends below aren't refused by trust.
    await fetch(`${h.baseUrl}/agents/me/allowlist`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${alice.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ entries: [bob.handle] }),
    });
    await fetch(`${h.baseUrl}/agents/me/allowlist`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bob.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ entries: [alice.handle] }),
    });

    const outId = "01HW7Z9KQX1MS2D9P5VC3GZ8A1";
    const selfId = "01HW7Z9KQX1MS2D9P5VC3GZ8A2";
    await fetch(`${h.baseUrl}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${alice.token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": outId,
      },
      body: JSON.stringify(ENVELOPE_TEXT_BODY(outId, [bob.handle])),
    });
    await fetch(`${h.baseUrl}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${alice.token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": selfId,
      },
      body: JSON.stringify(ENVELOPE_TEXT_BODY(selfId, [alice.handle])),
    });

    type Header = {
      id: string;
      from: string;
      direction?: string;
      unread?: boolean;
    };

    // Alice direction=in: only self-send (where she's a recipient).
    // Spec wire route — direction/unread fields omitted.
    const inRes = await fetch(`${h.baseUrl}/mailbox?direction=in&order=asc`, {
      headers: { Authorization: `Bearer ${alice.token}` },
    });
    const inBody = (await inRes.json()) as { envelope_headers: Header[] };
    assert.equal(inBody.envelope_headers.length, 1);
    assert.equal(inBody.envelope_headers[0]!.id, selfId);
    assert.equal(inBody.envelope_headers[0]!.direction, undefined);
    assert.equal(inBody.envelope_headers[0]!.unread, undefined);

    // Alice direction=out: both envelopes she sent. ``direction`` stamped.
    const outRes = await fetch(`${h.baseUrl}/mailbox?direction=out&order=asc`, {
      headers: { Authorization: `Bearer ${alice.token}` },
    });
    const outBody = (await outRes.json()) as { envelope_headers: Header[] };
    assert.equal(outBody.envelope_headers.length, 2);
    const outIds = outBody.envelope_headers.map((h) => h.id);
    assert.deepEqual(outIds.sort(), [outId, selfId].sort());
    // self-send is stamped ``self``, the other ``out``.
    const directionsById = Object.fromEntries(
      outBody.envelope_headers.map((h) => [h.id, h.direction]),
    );
    assert.equal(directionsById[outId], "out");
    assert.equal(directionsById[selfId], "self");

    // Alice direction=both: same two envelopes, self stamped ``self``.
    const bothRes = await fetch(`${h.baseUrl}/mailbox?direction=both&order=asc`, {
      headers: { Authorization: `Bearer ${alice.token}` },
    });
    const bothBody = (await bothRes.json()) as { envelope_headers: Header[] };
    assert.equal(bothBody.envelope_headers.length, 2);
    const bothById = Object.fromEntries(
      bothBody.envelope_headers.map((h) => [h.id, h]),
    );
    assert.equal(bothById[outId]!.direction, "out");
    assert.equal(bothById[selfId]!.direction, "self");
    // self-send should be unread (alice hasn't fetched it).
    assert.equal(bothById[selfId]!.unread, true);
    // out-only row has no recipient side for alice → unread omitted.
    assert.equal(bothById[outId]!.unread, undefined);
  });

  it("rejects unread=true with direction != in", async () => {
    const alice = await registerAgent(h, "@alice.cli");
    const res = await fetch(`${h.baseUrl}/mailbox?direction=out&unread=true`, {
      headers: { Authorization: `Bearer ${alice.token}` },
    });
    assert.equal(res.status, 400);
  });
});
