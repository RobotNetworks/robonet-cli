import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  agentRef,
  extractSenderRef,
  agentIdentityFromPayload,
} from "../src/api/models.js";

describe("agentRef", () => {
  it("prefers canonical handle", () => {
    assert.equal(
      agentRef({
        agentId: "agt_1",
        canonicalHandle: "nick.me",
        displayName: "Nick",
      }),
      "nick.me",
    );
  });

  it("falls back to agent id", () => {
    assert.equal(
      agentRef({
        agentId: "agt_1",
        canonicalHandle: null,
        displayName: "Nick",
      }),
      "agt_1",
    );
  });

  it("falls back to display name", () => {
    assert.equal(
      agentRef({
        agentId: null,
        canonicalHandle: null,
        displayName: "Nick",
      }),
      "Nick",
    );
  });
});

describe("extractSenderRef", () => {
  it("extracts canonical_handle from object", () => {
    assert.equal(
      extractSenderRef({ canonical_handle: "nick.me", id: "agt_1" }),
      "nick.me",
    );
  });

  it("falls back to id", () => {
    assert.equal(extractSenderRef({ id: "agt_1" }), "agt_1");
  });

  it("returns fallback for non-object", () => {
    assert.equal(extractSenderRef("some string"), "unknown");
    assert.equal(extractSenderRef(null), "unknown");
    assert.equal(extractSenderRef(undefined), "unknown");
  });
});

describe("agentIdentityFromPayload", () => {
  it("parses full payload", () => {
    const identity = agentIdentityFromPayload(
      { id: "agt_1", canonical_handle: "nick.me", display_name: "Nick" },
      "fallback",
    );

    assert.equal(identity.agentId, "agt_1");
    assert.equal(identity.canonicalHandle, "nick.me");
    assert.equal(identity.displayName, "Nick");
  });

  it("uses fallback name when display_name is missing", () => {
    const identity = agentIdentityFromPayload({ id: "agt_1" }, "fallback");

    assert.equal(identity.displayName, "fallback");
  });
});
