import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";

import { requestRefreshTokenExchange } from "../src/auth/pkce.js";
import { AuthenticationError } from "../src/errors.js";

let originalFetch: typeof globalThis.fetch;
let lastBody: string | null = null;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  lastBody = null;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubTokenEndpoint(response: Record<string, unknown>): void {
  globalThis.fetch = async (_input: unknown, init?: RequestInit) => {
    const body = init?.body;
    if (body instanceof URLSearchParams) {
      lastBody = body.toString();
    } else if (typeof body === "string") {
      lastBody = body;
    } else {
      lastBody = String(body ?? "");
    }
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

describe("requestRefreshTokenExchange — multi-resource encoding", () => {
  // Regression for the WS-handshake 401: the renewed bearer must keep
  // the same audience set as the original (api + websocket), otherwise
  // `robotnet listen` 401s after the first auto-refresh.
  it("encodes one resource= form param per resource", async () => {
    stubTokenEndpoint({
      access_token: "new-bearer",
      refresh_token: "new-refresh",
      expires_in: 900,
      scope: "agents:read realtime:read",
    });

    await requestRefreshTokenExchange({
      tokenEndpoint: "https://auth.test/token",
      clientId: "oac_abc",
      refreshToken: "rt_xyz",
      resources: ["https://api.test/v1", "wss://ws.test"],
      scope: "agents:read realtime:read",
    });

    assert.ok(lastBody, "fetch was not called");
    const parsed = new URLSearchParams(lastBody!);
    const resources = parsed.getAll("resource");
    assert.deepEqual(
      resources.sort(),
      ["https://api.test/v1", "wss://ws.test"].sort(),
      "both audiences must be present",
    );
    assert.equal(parsed.get("grant_type"), "refresh_token");
    assert.equal(parsed.get("client_id"), "oac_abc");
    assert.equal(parsed.get("refresh_token"), "rt_xyz");
  });

  it("works with a single resource (legacy / API-only callers)", async () => {
    stubTokenEndpoint({
      access_token: "x",
      refresh_token: "y",
    });

    await requestRefreshTokenExchange({
      tokenEndpoint: "https://auth.test/token",
      clientId: "oac_abc",
      refreshToken: "rt_xyz",
      resources: ["https://api.test/v1"],
      scope: "",
    });

    const parsed = new URLSearchParams(lastBody!);
    assert.deepEqual(parsed.getAll("resource"), ["https://api.test/v1"]);
  });

  it("rejects an empty resources array up front", async () => {
    await assert.rejects(
      () =>
        requestRefreshTokenExchange({
          tokenEndpoint: "https://auth.test/token",
          clientId: "oac_abc",
          refreshToken: "rt_xyz",
          resources: [],
          scope: "",
        }),
      AuthenticationError,
    );
  });
});
