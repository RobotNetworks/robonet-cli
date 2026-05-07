import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import type Database from "better-sqlite3";

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
  readonly handle: OperatorHandle;
  readonly db: Database.Database;
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "robotnet-op-self-"));
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
    body: JSON.stringify({ handle: agentHandle }),
  });
  if (reg.status !== 201) {
    throw new Error(`register failed: ${reg.status} ${await reg.text()}`);
  }
  const created = (await reg.json()) as { token: string };
  h.tokens.set(agentHandle, created.token);
  return created.token;
}

function agentHeaders(h: Harness, agentHandle: string, json = false): Record<string, string> {
  const token = h.tokens.get(agentHandle);
  if (token === undefined) throw new Error(`no token for ${agentHandle}`);
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (json) headers["Content-Type"] = "application/json";
  return headers;
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

describe("local operator /agents/me/allowlist", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness();
    await adminRegister(h, "@me.bot");
  });

  afterEach(async () => {
    await h.cleanup();
  });

  it("returns an empty list initially", async () => {
    const res = await fetch(`${h.baseUrl}/agents/me/allowlist`, {
      headers: agentHeaders(h, "@me.bot"),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { entries: string[] };
    assert.deepEqual(body, { entries: [] });
  });

  it("POST adds entries idempotently and returns the full list", async () => {
    const post = await fetch(`${h.baseUrl}/agents/me/allowlist`, {
      method: "POST",
      headers: agentHeaders(h, "@me.bot", true),
      body: JSON.stringify({ entries: ["@friend.bot", "@team.*"] }),
    });
    assert.equal(post.status, 200);
    const after = (await post.json()) as { entries: string[] };
    assert.deepEqual([...after.entries].sort(), ["@friend.bot", "@team.*"]);

    // Re-issuing the same batch is a no-op for the duplicates.
    const repost = await fetch(`${h.baseUrl}/agents/me/allowlist`, {
      method: "POST",
      headers: agentHeaders(h, "@me.bot", true),
      body: JSON.stringify({ entries: ["@friend.bot"] }),
    });
    assert.equal(repost.status, 200);
    const list = (await repost.json()) as { entries: string[] };
    assert.equal(list.entries.length, 2);
  });

  it("DELETE removes a single entry by value and returns the updated list", async () => {
    await fetch(`${h.baseUrl}/agents/me/allowlist`, {
      method: "POST",
      headers: agentHeaders(h, "@me.bot", true),
      body: JSON.stringify({ entries: ["@friend.bot", "@team.*"] }),
    });

    const del = await fetch(
      `${h.baseUrl}/agents/me/allowlist/${encodeURIComponent("@friend.bot")}`,
      { method: "DELETE", headers: agentHeaders(h, "@me.bot") },
    );
    assert.equal(del.status, 200);
    const after = (await del.json()) as { entries: string[] };
    assert.deepEqual([...after.entries], ["@team.*"]);
  });

  it("DELETE returns 404 for an entry that isn't present", async () => {
    const del = await fetch(
      `${h.baseUrl}/agents/me/allowlist/${encodeURIComponent("@ghost.bot")}`,
      { method: "DELETE", headers: agentHeaders(h, "@me.bot") },
    );
    assert.equal(del.status, 404);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const res = await fetch(`${h.baseUrl}/agents/me/allowlist`);
    assert.equal(res.status, 401);
  });

  it("rejects an invalid entry value at the parser boundary", async () => {
    const res = await fetch(`${h.baseUrl}/agents/me/allowlist`, {
      method: "POST",
      headers: agentHeaders(h, "@me.bot", true),
      body: JSON.stringify({ entries: ["not-a-handle"] }),
    });
    assert.equal(res.status, 400);
  });

  it("targets only the calling agent's own row (no third-party edit)", async () => {
    await adminRegister(h, "@other.bot");
    // Edit `@me.bot`'s allowlist via @other.bot's bearer — must affect
    // @other.bot's row, NOT @me.bot's. The route doesn't accept a target
    // handle in the URL at all; this test confirms the bearer-derived
    // identity is the only thing the route honors.
    const post = await fetch(`${h.baseUrl}/agents/me/allowlist`, {
      method: "POST",
      headers: agentHeaders(h, "@other.bot", true),
      body: JSON.stringify({ entries: ["@target.bot"] }),
    });
    assert.equal(post.status, 200);

    const meList = h.repo.agents.listAllowlist("@me.bot");
    const otherList = h.repo.agents.listAllowlist("@other.bot");
    assert.equal(meList.length, 0, "@me.bot allowlist should be untouched");
    assert.deepEqual(
      otherList.map((r) => r.entry),
      ["@target.bot"],
      "@other.bot's row got the entry",
    );
  });
});

describe("local operator /blocks", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness();
    await adminRegister(h, "@me.bot");
    await adminRegister(h, "@noisy.bot");
  });

  afterEach(async () => {
    await h.cleanup();
  });

  it("POST /blocks records a block and returns the row", async () => {
    const res = await fetch(`${h.baseUrl}/blocks`, {
      method: "POST",
      headers: agentHeaders(h, "@me.bot", true),
      body: JSON.stringify({ handle: "@noisy.bot" }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.blocked_handle, "@noisy.bot");
    assert.equal(body.blocked_agent_id, "@noisy.bot");
    assert.equal(typeof body.created_at, "number");
  });

  it("POST /blocks is idempotent — re-blocking is a no-op", async () => {
    const headers = agentHeaders(h, "@me.bot", true);
    const body = JSON.stringify({ handle: "@noisy.bot" });
    await fetch(`${h.baseUrl}/blocks`, { method: "POST", headers, body });
    const res = await fetch(`${h.baseUrl}/blocks`, { method: "POST", headers, body });
    assert.equal(res.status, 201);

    const list = (await (
      await fetch(`${h.baseUrl}/blocks`, { headers: agentHeaders(h, "@me.bot") })
    ).json()) as { blocks: unknown[] };
    assert.equal(list.blocks.length, 1);
  });

  it("rejects blocking yourself", async () => {
    const res = await fetch(`${h.baseUrl}/blocks`, {
      method: "POST",
      headers: agentHeaders(h, "@me.bot", true),
      body: JSON.stringify({ handle: "@me.bot" }),
    });
    assert.equal(res.status, 400);
  });

  it("GET /blocks returns the calling agent's blocks", async () => {
    await fetch(`${h.baseUrl}/blocks`, {
      method: "POST",
      headers: agentHeaders(h, "@me.bot", true),
      body: JSON.stringify({ handle: "@noisy.bot" }),
    });

    const res = await fetch(`${h.baseUrl}/blocks`, {
      headers: agentHeaders(h, "@me.bot"),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { blocks: Array<{ blocked_handle: string }>; next_cursor: string | null };
    assert.equal(body.blocks.length, 1);
    assert.equal(body.blocks[0].blocked_handle, "@noisy.bot");
    assert.equal(body.next_cursor, null);
  });

  it("DELETE /blocks/{handle} removes the block", async () => {
    await fetch(`${h.baseUrl}/blocks`, {
      method: "POST",
      headers: agentHeaders(h, "@me.bot", true),
      body: JSON.stringify({ handle: "@noisy.bot" }),
    });
    const del = await fetch(
      `${h.baseUrl}/blocks/${encodeURIComponent("@noisy.bot")}`,
      { method: "DELETE", headers: agentHeaders(h, "@me.bot") },
    );
    assert.equal(del.status, 200);
    const list = (await (
      await fetch(`${h.baseUrl}/blocks`, { headers: agentHeaders(h, "@me.bot") })
    ).json()) as { blocks: unknown[] };
    assert.equal(list.blocks.length, 0);
  });

  it("DELETE /blocks/{handle} returns 404 when not blocking", async () => {
    const del = await fetch(
      `${h.baseUrl}/blocks/${encodeURIComponent("@noisy.bot")}`,
      { method: "DELETE", headers: agentHeaders(h, "@me.bot") },
    );
    assert.equal(del.status, 404);
  });

  it("blocks are scoped to the calling agent", async () => {
    // @me.bot blocks @noisy.bot — @noisy.bot's own block list should stay empty.
    await fetch(`${h.baseUrl}/blocks`, {
      method: "POST",
      headers: agentHeaders(h, "@me.bot", true),
      body: JSON.stringify({ handle: "@noisy.bot" }),
    });
    const noisyView = (await (
      await fetch(`${h.baseUrl}/blocks`, { headers: agentHeaders(h, "@noisy.bot") })
    ).json()) as { blocks: unknown[] };
    assert.equal(noisyView.blocks.length, 0);
  });

  it("rejects unauthenticated requests", async () => {
    const res = await fetch(`${h.baseUrl}/blocks`);
    assert.equal(res.status, 401);
  });
});

describe("local operator /agents/me", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness();
    await adminRegister(h, "@me.bot");
  });

  afterEach(async () => {
    await h.cleanup();
  });

  it("GET returns an AgentResponse-shaped synthesis of the calling agent", async () => {
    const res = await fetch(`${h.baseUrl}/agents/me`, {
      headers: agentHeaders(h, "@me.bot"),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.canonical_handle, "@me.bot");
    assert.equal(body.local_name, "bot");
    assert.equal(body.namespace, "me");
    assert.equal(body.inbound_policy, "allowlist");
    assert.equal(body.is_online, true);
    assert.equal(body.paused, false);
    assert.equal(body.visibility, "private");
    assert.equal(body.display_name, "@me.bot"); // backfilled to handle on register
    assert.equal(body.description, null);
    assert.equal(body.card_body, null);
    assert.equal(body.owner_label, "@me");
  });

  it("PATCH updates display_name, description, and card_body", async () => {
    const res = await fetch(`${h.baseUrl}/agents/me`, {
      method: "PATCH",
      headers: agentHeaders(h, "@me.bot", true),
      body: JSON.stringify({
        display_name: "Billing Bot",
        description: "Handles billing",
        card_body: "# Billing\n\nWhat I do.",
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.display_name, "Billing Bot");
    assert.equal(body.description, "Handles billing");
    assert.equal(body.card_body, "# Billing\n\nWhat I do.");
  });

  it("PATCH treats null on description/card_body as a clear", async () => {
    await fetch(`${h.baseUrl}/agents/me`, {
      method: "PATCH",
      headers: agentHeaders(h, "@me.bot", true),
      body: JSON.stringify({ description: "set first" }),
    });
    const res = await fetch(`${h.baseUrl}/agents/me`, {
      method: "PATCH",
      headers: agentHeaders(h, "@me.bot", true),
      body: JSON.stringify({ description: null }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.description, null);
  });

  it("PATCH rejects an empty body", async () => {
    const res = await fetch(`${h.baseUrl}/agents/me`, {
      method: "PATCH",
      headers: agentHeaders(h, "@me.bot", true),
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });

  it("PATCH rejects an empty display_name", async () => {
    const res = await fetch(`${h.baseUrl}/agents/me`, {
      method: "PATCH",
      headers: agentHeaders(h, "@me.bot", true),
      body: JSON.stringify({ display_name: "" }),
    });
    assert.equal(res.status, 400);
  });

  it("rejects unauthenticated GET requests", async () => {
    const res = await fetch(`${h.baseUrl}/agents/me`);
    assert.equal(res.status, 401);
  });
});

describe("local operator GET /agents/{owner}/{name}", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness();
    await adminRegister(h, "@me.bot");
    await adminRegister(h, "@peer.support");
  });

  afterEach(async () => {
    await h.cleanup();
  });

  it("self-lookup is always allowed and reports owner relationship", async () => {
    const res = await fetch(`${h.baseUrl}/agents/me/bot`, {
      headers: agentHeaders(h, "@me.bot"),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      agent: Record<string, unknown>;
      viewer: { relationship: string; can_edit: boolean };
      shared_sessions: unknown[];
    };
    assert.equal(body.agent.canonical_handle, "@me.bot");
    assert.equal(body.viewer.relationship, "owner");
    assert.equal(body.viewer.can_edit, true);
    assert.deepEqual(body.shared_sessions, []);
  });

  it("404s a private agent the caller cannot see", async () => {
    // Both default to private. @me.bot is not on @peer.support's allowlist.
    const res = await fetch(`${h.baseUrl}/agents/peer/support`, {
      headers: agentHeaders(h, "@me.bot"),
    });
    assert.equal(res.status, 404);
  });

  it("returns the agent when caller is on the target's allowlist", async () => {
    // @peer.support adds @me.bot to its allowlist.
    await fetch(`${h.baseUrl}/agents/me/allowlist`, {
      method: "POST",
      headers: agentHeaders(h, "@peer.support", true),
      body: JSON.stringify({ entries: ["@me.bot"] }),
    });
    const res = await fetch(`${h.baseUrl}/agents/peer/support`, {
      headers: agentHeaders(h, "@me.bot"),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      agent: Record<string, unknown>;
      viewer: { relationship: string };
    };
    assert.equal(body.agent.canonical_handle, "@peer.support");
    assert.equal(body.viewer.relationship, "none");
  });

  it("returns the agent when target is public", async () => {
    // Promote @peer.support to public via the synthesized self-update.
    // (admin can't yet flip visibility; we do it via PATCH /agents/me as
    // the target itself — equivalent to the agent's owner setting it.)
    await fetch(`${h.baseUrl}/agents/me`, {
      method: "PATCH",
      headers: agentHeaders(h, "@peer.support", true),
      // Visibility is not a self-editable field today (admin-only on the
      // hosted side); we set it via the repo directly to test the
      // discovery branch.
      body: JSON.stringify({}),
    });
    h.repo.agents.updateProfile("@peer.support", { visibility: "public" });

    const res = await fetch(`${h.baseUrl}/agents/peer/support`, {
      headers: agentHeaders(h, "@me.bot"),
    });
    assert.equal(res.status, 200);
  });

  it("404s a missing handle (privacy-preserving)", async () => {
    const res = await fetch(`${h.baseUrl}/agents/ghost/bot`, {
      headers: agentHeaders(h, "@me.bot"),
    });
    assert.equal(res.status, 404);
  });

  it("rejects unauthenticated requests", async () => {
    const res = await fetch(`${h.baseUrl}/agents/me/bot`);
    assert.equal(res.status, 401);
  });
});

describe("local operator GET /search/agents", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness();
    await adminRegister(h, "@me.bot");
    await adminRegister(h, "@billing.bot");
    await adminRegister(h, "@billing.support");
    h.repo.agents.updateProfile("@billing.bot", {
      visibility: "public",
      displayName: "Billing Bot",
    });
    h.repo.agents.updateProfile("@billing.support", {
      visibility: "public",
      displayName: "Billing Support",
    });
  });

  afterEach(async () => {
    await h.cleanup();
  });

  it("returns matches by handle and display name", async () => {
    const res = await fetch(`${h.baseUrl}/search/agents?q=billing`, {
      headers: agentHeaders(h, "@me.bot"),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { agents: Array<{ canonical_handle: string }> };
    const handles = body.agents.map((a) => a.canonical_handle).sort();
    assert.deepEqual(handles, ["@billing.bot", "@billing.support"]);
  });

  it("filters out private agents the caller can't see", async () => {
    h.repo.agents.updateProfile("@billing.bot", { visibility: "private" });
    const res = await fetch(`${h.baseUrl}/search/agents?q=billing`, {
      headers: agentHeaders(h, "@me.bot"),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { agents: Array<{ canonical_handle: string }> };
    assert.deepEqual(
      body.agents.map((a) => a.canonical_handle),
      ["@billing.support"],
    );
  });

  it("400s a missing query", async () => {
    const res = await fetch(`${h.baseUrl}/search/agents`, {
      headers: agentHeaders(h, "@me.bot"),
    });
    assert.equal(res.status, 400);
  });

  it("rejects limit outside 1..50", async () => {
    const res = await fetch(`${h.baseUrl}/search/agents?q=billing&limit=999`, {
      headers: agentHeaders(h, "@me.bot"),
    });
    assert.equal(res.status, 400);
  });

  it("rejects unauthenticated requests", async () => {
    const res = await fetch(`${h.baseUrl}/search/agents?q=billing`);
    assert.equal(res.status, 401);
  });
});

describe("local operator GET /agents/{owner}/{name}/card", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness();
    await adminRegister(h, "@me.bot");
    await fetch(`${h.baseUrl}/agents/me`, {
      method: "PATCH",
      headers: agentHeaders(h, "@me.bot", true),
      body: JSON.stringify({ card_body: "# Hello\n\nI am @me.bot." }),
    });
  });

  afterEach(async () => {
    await h.cleanup();
  });

  it("returns the card body as markdown", async () => {
    const res = await fetch(`${h.baseUrl}/agents/me/bot/card`, {
      headers: agentHeaders(h, "@me.bot"),
    });
    assert.equal(res.status, 200);
    assert.match(
      res.headers.get("content-type") ?? "",
      /text\/markdown/,
    );
    assert.equal(await res.text(), "# Hello\n\nI am @me.bot.");
  });

  it("404s a private peer the caller cannot see", async () => {
    await adminRegister(h, "@peer.support");
    const res = await fetch(`${h.baseUrl}/agents/peer/support/card`, {
      headers: agentHeaders(h, "@me.bot"),
    });
    assert.equal(res.status, 404);
  });
});
