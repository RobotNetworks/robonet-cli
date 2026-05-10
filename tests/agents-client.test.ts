import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";

import { AgentDirectoryClient } from "../src/agents/client.js";
import { CapabilityNotSupportedError } from "../src/agents/errors.js";
import { isFullAgentResponse } from "../src/agents/types.js";
import { AspApiError } from "../src/asp/errors.js";

const BASE = "https://api.example/v1";
const TOKEN = "test-bearer";
const NETWORK = "global";

function makeClient(): AgentDirectoryClient {
  return new AgentDirectoryClient(BASE, TOKEN, NETWORK);
}

interface FetchCall {
  readonly url: string;
  readonly init?: RequestInit;
}

let originalFetch: typeof globalThis.fetch;
let calls: FetchCall[] = [];

beforeEach(() => {
  originalFetch = globalThis.fetch;
  calls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubFetch(handler: (url: string, init?: RequestInit) => Response): void {
  globalThis.fetch = async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    calls.push({ url, ...(init !== undefined ? { init } : {}) });
    return handler(url, init);
  };
}

const PUBLIC_AGENT = {
  canonical_handle: "@owner.cli",
  display_name: "Owner CLI",
  description: null,
  image_url: null,
  visibility: "public",
  inbound_policy: "allowlist",
  inactive: false,
  is_online: true,
  owner_label: "@owner",
  owner_display_name: "Owner",
  owner_image_url: null,
};

const FULL_AGENT = {
  ...PUBLIC_AGENT,
  id: "agt_01",
  local_name: "cli",
  namespace: "owner",
  owner_type: "account",
  owner_id: "acct_01",
  scope: "personal",
  can_initiate_sessions: true,
  paused: false,
  card_body: "# Hello\nI am the CLI.",
  skills: [{ name: "register", description: "register an agent" }],
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_001_000,
};

describe("AgentDirectoryClient.getAgent", () => {
  it("returns the wrapper with limited agent shape and reaches the canonical path", async () => {
    stubFetch(() =>
      new Response(
        JSON.stringify({
          agent: PUBLIC_AGENT,
          shared_sessions: [],
          viewer: { relationship: "none", can_edit: false },
        }),
        { status: 200 },
      ),
    );

    const detail = await makeClient().getAgent("@owner.cli");
    assert.equal(detail.agent.canonical_handle, "@owner.cli");
    assert.equal(isFullAgentResponse(detail.agent), false);
    assert.equal(detail.viewer.relationship, "none");
    assert.equal(detail.shared_sessions.length, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, `${BASE}/agents/owner/cli`);
  });

  it("returns the full agent shape inside the wrapper", async () => {
    stubFetch(() =>
      new Response(
        JSON.stringify({
          agent: FULL_AGENT,
          shared_sessions: [
            {
              id: "sess_01",
              topic: "intro",
              state: "active",
              last_activity_at: 1_700_000_002_000,
              created_at: 1_700_000_000_000,
            },
          ],
          viewer: { relationship: "owner", can_edit: true },
        }),
        { status: 200 },
      ),
    );

    const detail = await makeClient().getAgent("@owner.cli");
    assert.equal(isFullAgentResponse(detail.agent), true);
    if (isFullAgentResponse(detail.agent)) {
      assert.equal(detail.agent.skills?.length, 1);
      assert.equal(detail.agent.card_body, "# Hello\nI am the CLI.");
    }
    assert.equal(detail.shared_sessions.length, 1);
    assert.equal(detail.viewer.relationship, "owner");
    assert.equal(detail.viewer.can_edit, true);
  });

  it("propagates 404 as AspApiError (privacy-preserving 'not visible')", async () => {
    stubFetch(() => new Response("", { status: 404 }));
    await assert.rejects(() => makeClient().getAgent("@owner.cli"), AspApiError);
  });

  it("translates 501 to CapabilityNotSupportedError", async () => {
    stubFetch(() => new Response("", { status: 501 }));
    await assert.rejects(
      () => makeClient().getAgent("@owner.cli"),
      CapabilityNotSupportedError,
    );
  });
});

describe("AgentDirectoryClient.getAgentCard", () => {
  it("returns the markdown body verbatim", async () => {
    stubFetch(
      () =>
        new Response("# Hello\nLine 2", {
          status: 200,
          headers: { "Content-Type": "text/markdown; charset=utf-8" },
        }),
    );
    const card = await makeClient().getAgentCard("@owner.cli");
    assert.equal(card, "# Hello\nLine 2");
    assert.equal(calls[0]!.url, `${BASE}/agents/owner/cli/card`);
  });

  it("propagates 404 as AspApiError (the agent doesn't exist or isn't visible)", async () => {
    stubFetch(() => new Response("", { status: 404 }));
    await assert.rejects(
      () => makeClient().getAgentCard("@owner.cli"),
      AspApiError,
    );
  });

  it("translates 501 to CapabilityNotSupportedError", async () => {
    stubFetch(() => new Response("", { status: 501 }));
    await assert.rejects(
      () => makeClient().getAgentCard("@owner.cli"),
      CapabilityNotSupportedError,
    );
  });
});

describe("AgentDirectoryClient.searchAgents", () => {
  it("encodes query+limit and returns the agents array", async () => {
    stubFetch(() =>
      new Response(
        JSON.stringify({
          agents: [
            { type: "agent", id: "a1", canonical_handle: "@owner.cli", display_name: "Owner", image_url: null },
          ],
        }),
        { status: 200 },
      ),
    );
    const result = await makeClient().searchAgents("owner bot", 5);
    assert.equal(result.agents.length, 1);
    const url = new URL(calls[0]!.url);
    assert.equal(url.pathname, "/v1/search/agents");
    assert.equal(url.searchParams.get("q"), "owner bot");
    assert.equal(url.searchParams.get("limit"), "5");
  });

  it("translates 404 to CapabilityNotSupportedError (no domain-level 404 on /search)", async () => {
    stubFetch(() => new Response("", { status: 404 }));
    await assert.rejects(
      () => makeClient().searchAgents("x", 5),
      CapabilityNotSupportedError,
    );
  });

  it("translates 405 and 501 to CapabilityNotSupportedError", async () => {
    for (const status of [405, 501]) {
      stubFetch(() => new Response("", { status }));
      await assert.rejects(
        () => makeClient().searchAgents("x", 5),
        CapabilityNotSupportedError,
        `status ${status} should translate`,
      );
    }
  });

  it("propagates non-capability errors as AspApiError", async () => {
    stubFetch(() => new Response("", { status: 500 }));
    await assert.rejects(() => makeClient().searchAgents("x", 5), AspApiError);
  });
});

describe("AgentDirectoryClient.searchDirectory", () => {
  it("returns the three typed sections", async () => {
    stubFetch(() =>
      new Response(
        JSON.stringify({
          agents: [],
          people: [
            {
              type: "person",
              id: "p1",
              username: "owner",
              display_name: "Owner",
              image_url: null,
            },
          ],
          organizations: [
            {
              type: "organization",
              id: "o1",
              slug: "acme",
              name: "ACME Inc",
              image_url: null,
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const result = await makeClient().searchDirectory("owner", 10);
    assert.equal(result.agents.length, 0);
    assert.equal(result.people.length, 1);
    assert.equal(result.people[0]!.username, "owner");
    assert.equal(result.organizations.length, 1);
    assert.equal(result.organizations[0]!.slug, "acme");
    const url = new URL(calls[0]!.url);
    assert.equal(url.pathname, "/v1/search");
  });
});

describe("AgentDirectoryClient.getSelf / updateSelf", () => {
  it("getSelf returns the full AgentResponse from /agents/me", async () => {
    stubFetch(() => new Response(JSON.stringify(FULL_AGENT), { status: 200 }));
    const self = await makeClient().getSelf();
    assert.equal(self.canonical_handle, "@owner.cli");
    assert.equal(self.id, "agt_01");
    assert.equal(calls[0]!.url, `${BASE}/agents/me`);
  });

  it("updateSelf sends a PATCH with the supplied fields", async () => {
    stubFetch((_url, init) => {
      assert.equal(init?.method, "PATCH");
      const body = JSON.parse(String(init?.body ?? "null"));
      assert.deepEqual(body, {
        display_name: "New Name",
        description: null,
      });
      return new Response(
        JSON.stringify({ ...FULL_AGENT, display_name: "New Name", description: null }),
        { status: 200 },
      );
    });
    const updated = await makeClient().updateSelf({
      display_name: "New Name",
      description: null,
    });
    assert.equal(updated.display_name, "New Name");
    assert.equal(updated.description, null);
  });

  it("getSelf translates 501 to CapabilityNotSupportedError", async () => {
    stubFetch(() => new Response("", { status: 501 }));
    await assert.rejects(() => makeClient().getSelf(), CapabilityNotSupportedError);
  });
});

describe("AgentDirectoryClient.listBlocks / blockAgent / unblockAgent", () => {
  it("listBlocks hits GET /blocks with optional limit", async () => {
    stubFetch(() =>
      new Response(JSON.stringify({ blocks: [], next_cursor: null }), { status: 200 }),
    );
    await makeClient().listBlocks({ limit: 25 });
    const url = new URL(calls[0]!.url);
    assert.equal(url.pathname, "/v1/agents/me/blocks");
    assert.equal(url.searchParams.get("limit"), "25");
  });

  it("listBlocks omits the query string when no options are supplied", async () => {
    stubFetch(() =>
      new Response(JSON.stringify({ blocks: [], next_cursor: null }), { status: 200 }),
    );
    await makeClient().listBlocks();
    const url = new URL(calls[0]!.url);
    assert.equal(url.pathname, "/v1/agents/me/blocks");
    assert.equal(url.searchParams.toString(), "");
  });

  it("blockAgent POSTs to /agents/me/blocks with the handle in the body", async () => {
    stubFetch((_url, init) => {
      assert.equal(init?.method, "POST");
      const body = JSON.parse(String(init?.body ?? "null"));
      assert.deepEqual(body, { handle: "@noisy.bot" });
      return new Response(
        JSON.stringify({
          blocked_agent_id: "agt_n",
          blocked_handle: "@noisy.bot",
          created_at: 1,
        }),
        { status: 201 },
      );
    });
    await makeClient().blockAgent("@noisy.bot");
    assert.equal(calls[0]!.url, `${BASE}/agents/me/blocks`);
  });

  it("unblockAgent DELETEs /agents/me/blocks/{handle} URL-encoded", async () => {
    stubFetch(() => new Response(JSON.stringify({ unblocked: true }), { status: 200 }));
    await makeClient().unblockAgent("@noisy.bot");
    assert.equal(calls[0]!.url, `${BASE}/agents/me/blocks/${encodeURIComponent("@noisy.bot")}`);
    assert.equal(calls[0]!.init?.method, "DELETE");
  });
});

describe("AgentDirectoryClient handle parsing", () => {
  it("URL-encodes owner and name segments", async () => {
    stubFetch(() => new Response("# card", { status: 200 }));
    await makeClient().getAgentCard("@a-1.b_2");
    const url = new URL(calls[0]!.url);
    assert.equal(url.pathname, "/v1/agents/a-1/b_2/card");
  });
});

describe("AgentDirectoryClient self-allowlist", () => {
  it("getSelfAllowlist GETs /agents/me/allowlist and returns the entries", async () => {
    stubFetch(() =>
      new Response(JSON.stringify({ entries: ["@friend.bot", "@team.*"] }), {
        status: 200,
      }),
    );
    const result = await makeClient().getSelfAllowlist();
    assert.deepEqual([...result.entries], ["@friend.bot", "@team.*"]);
    assert.equal(calls[0]!.url, `${BASE}/agents/me/allowlist`);
    assert.equal(calls[0]!.init?.method, "GET");
  });

  it("addSelfAllowlistEntries POSTs entries to /agents/me/allowlist", async () => {
    stubFetch((_url, init) => {
      assert.equal(init?.method, "POST");
      const body = JSON.parse(String(init?.body ?? "null"));
      assert.deepEqual(body, { entries: ["@friend.bot", "@team.*"] });
      return new Response(
        JSON.stringify({ entries: ["@friend.bot", "@team.*"] }),
        { status: 200 },
      );
    });
    const result = await makeClient().addSelfAllowlistEntries([
      "@friend.bot",
      "@team.*",
    ]);
    assert.deepEqual([...result.entries], ["@friend.bot", "@team.*"]);
  });

  it("addSelfAllowlistEntries rejects malformed entries before calling the network", async () => {
    let called = false;
    stubFetch(() => {
      called = true;
      return new Response("{}", { status: 200 });
    });
    await assert.rejects(
      () => makeClient().addSelfAllowlistEntries(["not-a-handle"]),
      /invalid allowlist entry/,
    );
    assert.equal(called, false);
  });

  it("removeSelfAllowlistEntry DELETEs /agents/me/allowlist/{entry} URL-encoded", async () => {
    stubFetch(() => new Response(JSON.stringify({ entries: [] }), { status: 200 }));
    await makeClient().removeSelfAllowlistEntry("@friend.bot");
    assert.equal(
      calls[0]!.url,
      `${BASE}/agents/me/allowlist/${encodeURIComponent("@friend.bot")}`,
    );
    assert.equal(calls[0]!.init?.method, "DELETE");
  });

  it("removeSelfAllowlistEntry rejects malformed entry before calling the network", async () => {
    let called = false;
    stubFetch(() => {
      called = true;
      return new Response("{}", { status: 200 });
    });
    await assert.rejects(
      () => makeClient().removeSelfAllowlistEntry("not-a-handle"),
      /invalid allowlist entry/,
    );
    assert.equal(called, false);
  });

  it("translates 501 on the read path to CapabilityNotSupportedError", async () => {
    stubFetch(() => new Response("", { status: 501 }));
    await assert.rejects(
      () => makeClient().getSelfAllowlist(),
      CapabilityNotSupportedError,
    );
  });
});
