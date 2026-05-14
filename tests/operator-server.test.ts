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
    const { file_id, url } = (await uploadRes.json()) as {
      file_id: string;
      url: string;
    };
    assert.ok(file_id.startsWith("file_"));
    assert.ok(url.includes(`/files/${file_id}`));

    const downloadRes = await fetch(url, {
      headers: { Authorization: `Bearer ${alice.token}` },
    });
    assert.equal(downloadRes.status, 200);
    const bytes = new Uint8Array(await downloadRes.arrayBuffer());
    assert.equal(bytes.byteLength, pngHeader.length);
  });
});
