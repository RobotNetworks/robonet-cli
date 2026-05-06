import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";

import { AccountClient } from "../src/account/client.js";
import { CapabilityNotSupportedError } from "../src/agents/errors.js";
import { AspApiError } from "../src/asp/errors.js";

const BASE = "https://api.example/v1";
const TOKEN = "user-bearer";
const NETWORK = "public";

function makeClient(): AccountClient {
  return new AccountClient(BASE, TOKEN, NETWORK);
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

const STUB_AGENT = {
  canonical_handle: "@nick.cli",
  display_name: "Nick CLI",
  description: null,
  image_url: null,
  visibility: "public",
  inbound_policy: "allowlist",
  inactive: false,
  is_online: false,
  owner_label: "@nick",
  owner_display_name: "Nick",
  owner_image_url: null,
  id: "agt_01",
  local_name: "cli",
  namespace: "nick",
  owner_type: "account",
  owner_id: "acc_01",
  scope: "personal",
  can_initiate_sessions: true,
  paused: false,
  card_body: null,
  skills: null,
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_001_000,
};

describe("AccountClient.getAccount", () => {
  it("hits GET /account and returns the response shape", async () => {
    const account = {
      id: "acc_1",
      username: "nick",
      email: "nick@example.com",
      display_name: "Nick",
      bio: null,
      image_url: null,
      tier: "free",
      created_at: 1,
      updated_at: 1,
    };
    stubFetch(() => new Response(JSON.stringify(account), { status: 200 }));
    const result = await makeClient().getAccount();
    assert.equal(result.id, "acc_1");
    assert.equal(result.username, "nick");
    assert.equal(calls[0]!.url, `${BASE}/account`);
    assert.equal(calls[0]!.init?.method, "GET");
  });

  it("translates 501 to CapabilityNotSupportedError", async () => {
    stubFetch(() => new Response("", { status: 501 }));
    await assert.rejects(
      () => makeClient().getAccount(),
      CapabilityNotSupportedError,
    );
  });
});

describe("AccountClient.listAgents", () => {
  it("hits GET /agents and returns the wire envelope", async () => {
    stubFetch(() =>
      new Response(
        JSON.stringify({ agents: [STUB_AGENT], next_cursor: null }),
        { status: 200 },
      ),
    );
    const result = await makeClient().listAgents();
    assert.equal(result.agents.length, 1);
    assert.equal(result.next_cursor, null);
    const url = new URL(calls[0]!.url);
    assert.equal(url.pathname, "/v1/agents");
    assert.equal(url.searchParams.toString(), "");
    assert.equal(calls[0]!.init?.method, "GET");
  });

  it("forwards query/limit/cursor when supplied", async () => {
    stubFetch(() =>
      new Response(JSON.stringify({ agents: [], next_cursor: null }), { status: 200 }),
    );
    await makeClient().listAgents({ query: "nick", limit: 10, cursor: "100" });
    const url = new URL(calls[0]!.url);
    assert.equal(url.searchParams.get("q"), "nick");
    assert.equal(url.searchParams.get("limit"), "10");
    assert.equal(url.searchParams.get("cursor"), "100");
  });

  it("translates 501 to CapabilityNotSupportedError", async () => {
    stubFetch(() => new Response("", { status: 501 }));
    await assert.rejects(() => makeClient().listAgents(), CapabilityNotSupportedError);
  });
});

describe("AccountClient.listManagedAgents", () => {
  it("hits GET /agents/managed", async () => {
    stubFetch(() =>
      new Response(JSON.stringify({ agents: [STUB_AGENT], next_cursor: null }), { status: 200 }),
    );
    const result = await makeClient().listManagedAgents();
    assert.equal(result.agents.length, 1);
    const url = new URL(calls[0]!.url);
    assert.equal(url.pathname, "/v1/agents/managed");
  });
});

describe("AccountClient.createAgent", () => {
  it("POSTs a properly-shaped body and returns the created agent", async () => {
    stubFetch((_url, init) => {
      assert.equal(init?.method, "POST");
      const body = JSON.parse(String(init?.body ?? "null"));
      assert.deepEqual(body, {
        local_name: "cli",
        display_name: "Nick CLI",
        visibility: "public",
      });
      return new Response(JSON.stringify(STUB_AGENT), { status: 201 });
    });
    const created = await makeClient().createAgent({
      local_name: "cli",
      display_name: "Nick CLI",
      visibility: "public",
    });
    assert.equal(created.canonical_handle, "@nick.cli");
    assert.equal(calls[0]!.url, `${BASE}/agents`);
  });
});

describe("AccountClient.updateAgent", () => {
  it("PATCHes /agents/{owner}/{name} with the supplied fields", async () => {
    stubFetch((_url, init) => {
      assert.equal(init?.method, "PATCH");
      const body = JSON.parse(String(init?.body ?? "null"));
      assert.deepEqual(body, { paused: true });
      return new Response(JSON.stringify({ ...STUB_AGENT, paused: true }), {
        status: 200,
      });
    });
    const updated = await makeClient().updateAgent("@nick.cli", { paused: true });
    assert.equal(updated.paused, true);
    assert.equal(calls[0]!.url, `${BASE}/agents/nick/cli`);
  });
});

describe("AccountClient.deleteAgent", () => {
  it("DELETEs /agents/{owner}/{name}", async () => {
    stubFetch(() => new Response(null, { status: 204 }));
    await makeClient().deleteAgent("@nick.cli");
    assert.equal(calls[0]!.url, `${BASE}/agents/nick/cli`);
    assert.equal(calls[0]!.init?.method, "DELETE");
  });
});

describe("AccountClient.listSessions", () => {
  it("hits GET /accounts/me/sessions and forwards filters", async () => {
    stubFetch(() =>
      new Response(JSON.stringify({ sessions: [], next_cursor: null }), { status: 200 }),
    );
    await makeClient().listSessions({ state: "active", limit: 25 });
    const url = new URL(calls[0]!.url);
    assert.equal(url.pathname, "/v1/accounts/me/sessions");
    assert.equal(url.searchParams.get("state"), "active");
    assert.equal(url.searchParams.get("limit"), "25");
  });

  it("translates 501 to CapabilityNotSupportedError", async () => {
    stubFetch(() => new Response("", { status: 501 }));
    await assert.rejects(
      () => makeClient().listSessions(),
      CapabilityNotSupportedError,
    );
  });

  it("propagates non-capability errors as AspApiError", async () => {
    stubFetch(() => new Response("", { status: 500 }));
    await assert.rejects(() => makeClient().listSessions(), AspApiError);
  });
});

describe("AccountClient handle parsing", () => {
  it("URL-encodes owner and name segments", async () => {
    stubFetch(() => new Response(null, { status: 204 }));
    await makeClient().deleteAgent("@a-1.b_2");
    const url = new URL(calls[0]!.url);
    assert.equal(url.pathname, "/v1/agents/a-1/b_2");
  });
});
