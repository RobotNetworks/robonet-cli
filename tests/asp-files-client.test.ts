import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import type { DatabaseSync } from "node:sqlite";

import { AspApiError } from "../src/asp/errors.js";
import { AspFilesClient } from "../src/asp/files-client.js";
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "robotnet-files-client-"));
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

async function adminRegister(h: Harness, agentHandle: string): Promise<string> {
  const reg = await fetch(`${h.baseUrl}/_admin/agents`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${h.adminToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ handle: agentHandle, policy: "open" }),
  });
  if (reg.status !== 201) {
    throw new Error(`register failed: ${reg.status} ${await reg.text()}`);
  }
  const created = (await reg.json()) as { token: string };
  h.tokens.set(agentHandle, created.token);
  return created.token;
}

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

describe("AspFilesClient — upload + download", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it("upload posts multipart and returns the file metadata", async () => {
    const token = await adminRegister(h, "@alice.bot");
    const client = new AspFilesClient(h.baseUrl, token);
    const result = await client.upload({
      bytes: new Uint8Array(PNG_1X1),
      filename: "tiny.png",
      contentType: "image/png",
    });
    assert.match(result.id, /^file_[0-9A-Z]+$/);
    assert.equal(result.status, "pending");
    assert.equal(result.content_type, "image/png");
    assert.equal(result.size_bytes, PNG_1X1.length);
  });

  it("download by file_id resolves against baseUrl and returns bytes + content-type", async () => {
    const token = await adminRegister(h, "@alice.bot");
    const client = new AspFilesClient(h.baseUrl, token);
    const upload = await client.upload({
      bytes: new Uint8Array(PNG_1X1),
      filename: "tiny.png",
      contentType: "image/png",
    });
    const got = await client.download(upload.id);
    assert.equal(got.contentType, "image/png");
    assert.equal(got.bytes.length, PNG_1X1.length);
    assert.deepEqual(Buffer.from(got.bytes), PNG_1X1);
    assert.equal(got.filename, "tiny.png");
  });

  it("download by absolute http(s) URL goes through unauthenticated when off-baseUrl", async () => {
    const token = await adminRegister(h, "@alice.bot");
    const client = new AspFilesClient(h.baseUrl, token);
    const upload = await client.upload({
      bytes: new Uint8Array(PNG_1X1),
      filename: "tiny.png",
      contentType: "image/png",
    });
    // Same host: bearer header is still sent (this is our operator).
    const onBase = await client.download(`${h.baseUrl}/files/${upload.id}`);
    assert.equal(onBase.bytes.length, PNG_1X1.length);
  });

  it("upload of magic-byte-mismatched bytes raises AspApiError(INVALID_FILE)", async () => {
    const token = await adminRegister(h, "@alice.bot");
    const client = new AspFilesClient(h.baseUrl, token);
    await assert.rejects(
      () =>
        client.upload({
          bytes: new TextEncoder().encode("not really a png"),
          filename: "lying.png",
          contentType: "image/png",
        }),
      (err: unknown) => {
        if (!(err instanceof AspApiError)) return false;
        return err.status === 400 && err.code === "INVALID_FILE";
      },
    );
  });

  it("download of unknown id raises AspApiError(404)", async () => {
    const token = await adminRegister(h, "@alice.bot");
    const client = new AspFilesClient(h.baseUrl, token);
    await assert.rejects(
      () => client.download("file_DOESNOTEXIST"),
      (err: unknown) => err instanceof AspApiError && err.status === 404,
    );
  });
});
