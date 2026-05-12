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

interface Harness {
  readonly config: OperatorConfig;
  readonly adminToken: string;
  readonly db: DatabaseSync;
  readonly repo: OperatorRepository;
  readonly cleanup: () => void;
}

async function makeHarness(): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "robotnet-op-server-"));
  const dbPath = path.join(dir, "operator.sqlite");
  const port = await pickPort();
  const adminToken = "admin_test_token_" + Math.random().toString(36).slice(2);
  const config: OperatorConfig = {
    networkName: "local",
    host: "127.0.0.1",
    port,
    databasePath: dbPath,
    filesDir: path.join(path.dirname(dbPath), "files"),
    adminTokenHash: sha256Hex(adminToken),
    operatorVersion: "0.0.0-test",
  };
  const db = openOperatorDatabase(dbPath);
  const repo = new OperatorRepository(db);
  return {
    config,
    adminToken,
    db,
    repo,
    cleanup: () => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function runWithServer<T>(
  h: Harness,
  fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const handle: OperatorHandle = await startOperatorServer({
    config: h.config,
    db: h.db,
    repo: h.repo,
  });
  try {
    return await fn(`http://${handle.host}:${handle.port}`);
  } finally {
    await handle.close();
  }
}

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(() => {
  h.cleanup();
});

function adminHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

/* -------------------------------------------------------------------------- */

describe("operator server — built-ins", () => {
  it("/healthz is accessible without auth", async () => {
    await runWithServer(h, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/healthz`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body.ok, true);
      assert.equal(body.network, "local");
      assert.equal(body.version, "0.0.0-test");
    });
  });

  it("unknown routes return 404 with an ASP-shaped envelope", async () => {
    await runWithServer(h, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/nope`);
      assert.equal(res.status, 404);
      const body = (await res.json()) as { error?: { code?: string } };
      assert.equal(body.error?.code, "NOT_FOUND");
    });
  });
});

describe("operator server — admin auth", () => {
  it("rejects admin requests without a bearer token", async () => {
    await runWithServer(h, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/_admin/agents`);
      assert.equal(res.status, 401);
      const body = (await res.json()) as { error?: { code?: string } };
      assert.equal(body.error?.code, "UNAUTHORIZED");
    });
  });

  it("rejects admin requests with the wrong bearer token", async () => {
    await runWithServer(h, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/_admin/agents`, {
        headers: { Authorization: "Bearer wrong" },
      });
      assert.equal(res.status, 401);
    });
  });
});

describe("operator server — admin agents", () => {
  it("registers, lists, fetches, and deletes agents", async () => {
    await runWithServer(h, async (baseUrl) => {
      // Register.
      const reg = await fetch(`${baseUrl}/_admin/agents`, {
        method: "POST",
        headers: adminHeaders(h.adminToken),
        body: JSON.stringify({ handle: "@example.bot" }),
      });
      assert.equal(reg.status, 201);
      const created = (await reg.json()) as {
        handle: string;
        token: string;
        policy: string;
        allowlist: string[];
      };
      assert.equal(created.handle, "@example.bot");
      assert.equal(created.policy, "allowlist");
      assert.deepEqual(created.allowlist, []);
      assert.equal(typeof created.token, "string");
      assert.ok(created.token.length > 20);

      // List.
      const list = await fetch(`${baseUrl}/_admin/agents`, {
        headers: adminHeaders(h.adminToken),
      });
      assert.equal(list.status, 200);
      const listed = (await list.json()) as { agents: { handle: string; token?: string }[] };
      assert.equal(listed.agents.length, 1);
      // Token is NOT returned on list (we only have hashes).
      assert.equal(listed.agents[0].token, undefined);

      // Get.
      const get = await fetch(`${baseUrl}/_admin/agents/@example.bot`, {
        headers: adminHeaders(h.adminToken),
      });
      assert.equal(get.status, 200);
      const got = (await get.json()) as { handle: string; token?: string };
      assert.equal(got.handle, "@example.bot");
      assert.equal(got.token, undefined);

      // Delete.
      const del = await fetch(`${baseUrl}/_admin/agents/@example.bot`, {
        method: "DELETE",
        headers: adminHeaders(h.adminToken),
      });
      assert.equal(del.status, 204);

      // Re-fetch returns 404.
      const got2 = await fetch(`${baseUrl}/_admin/agents/@example.bot`, {
        headers: adminHeaders(h.adminToken),
      });
      assert.equal(got2.status, 404);
    });
  });

  it("register rejects duplicate handles with 409", async () => {
    await runWithServer(h, async (baseUrl) => {
      const body = JSON.stringify({ handle: "@dup.bot" });
      const a = await fetch(`${baseUrl}/_admin/agents`, {
        method: "POST",
        headers: adminHeaders(h.adminToken),
        body,
      });
      assert.equal(a.status, 201);
      const b = await fetch(`${baseUrl}/_admin/agents`, {
        method: "POST",
        headers: adminHeaders(h.adminToken),
        body,
      });
      assert.equal(b.status, 409);
      const detail = (await b.json()) as { error?: { code?: string } };
      assert.equal(detail.error?.code, "AGENT_EXISTS");
    });
  });

  it("rejects invalid handles with 400", async () => {
    await runWithServer(h, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/_admin/agents`, {
        method: "POST",
        headers: adminHeaders(h.adminToken),
        body: JSON.stringify({ handle: "not-a-handle" }),
      });
      assert.equal(res.status, 400);
      const detail = (await res.json()) as { error?: { code?: string } };
      assert.equal(detail.error?.code, "INVALID_HANDLE");
    });
  });

  it("rotate-token issues a fresh bearer and invalidates the old one", async () => {
    await runWithServer(h, async (baseUrl) => {
      const reg = await fetch(`${baseUrl}/_admin/agents`, {
        method: "POST",
        headers: adminHeaders(h.adminToken),
        body: JSON.stringify({ handle: "@x.bot" }),
      });
      const old = (await reg.json()) as { token: string };

      const rotate = await fetch(
        `${baseUrl}/_admin/agents/@x.bot/rotate-token`,
        { method: "POST", headers: adminHeaders(h.adminToken) },
      );
      assert.equal(rotate.status, 200);
      const fresh = (await rotate.json()) as { token: string };
      assert.notEqual(fresh.token, old.token);
      assert.ok(fresh.token.length > 20);

      // Hash-store comparison: only the new token's hash is in the agents row.
      const stored = h.repo.agents.byHandle("@x.bot");
      assert.equal(stored?.bearerTokenHash, sha256Hex(fresh.token));
      assert.notEqual(stored?.bearerTokenHash, sha256Hex(old.token));
    });
  });

  it("PATCH /_admin/agents/:handle sets the inbound policy", async () => {
    await runWithServer(h, async (baseUrl) => {
      await fetch(`${baseUrl}/_admin/agents`, {
        method: "POST",
        headers: adminHeaders(h.adminToken),
        body: JSON.stringify({ handle: "@y.bot" }),
      });

      const res = await fetch(`${baseUrl}/_admin/agents/@y.bot`, {
        method: "PATCH",
        headers: adminHeaders(h.adminToken),
        body: JSON.stringify({ policy: "open" }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { policy: string };
      assert.equal(body.policy, "open");

      const stored = h.repo.agents.byHandle("@y.bot");
      assert.equal(stored?.inboundPolicy, "open");
    });
  });

  it("PATCH rejects an invalid policy with 400", async () => {
    await runWithServer(h, async (baseUrl) => {
      await fetch(`${baseUrl}/_admin/agents`, {
        method: "POST",
        headers: adminHeaders(h.adminToken),
        body: JSON.stringify({ handle: "@y.bot" }),
      });
      const res = await fetch(`${baseUrl}/_admin/agents/@y.bot`, {
        method: "PATCH",
        headers: adminHeaders(h.adminToken),
        body: JSON.stringify({ policy: "nonsense" }),
      });
      assert.equal(res.status, 400);
      const detail = (await res.json()) as { error?: { code?: string } };
      assert.equal(detail.error?.code, "INVALID_POLICY");
    });
  });

  // The third-party admin-side allowlist edit routes
  // (`POST /_admin/agents/{h}/allowlist`, `DELETE /_admin/agents/{h}/allowlist/{e}`)
  // were removed: under the actor model, an agent's allowlist is
  // self-owned and edited only via the agent-bearer route at `/allowlist`
  // (covered in tests/operator-self.test.ts).

  it("PATCH on an unknown handle returns 404", async () => {
    await runWithServer(h, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/_admin/agents/@missing.bot`, {
        method: "PATCH",
        headers: adminHeaders(h.adminToken),
        body: JSON.stringify({ policy: "open" }),
      });
      assert.equal(res.status, 404);
    });
  });
});
