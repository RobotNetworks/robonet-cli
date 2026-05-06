import { describe, it } from "node:test";
import * as assert from "node:assert/strict";

import type { NetworkConfig } from "../src/config.js";
import { NotALocalNetworkError } from "../src/network/errors.js";
import { assertLocalNetwork, networkPort } from "../src/network/local-network.js";

describe("assertLocalNetwork", () => {
  it("accepts the builtin local network", () => {
    const net: NetworkConfig = {
      name: "local",
      url: "http://127.0.0.1:8723",
      authMode: "agent-token",
    };
    assert.doesNotThrow(() => assertLocalNetwork(net));
  });

  it("accepts custom loopback agent-token networks", () => {
    for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
      const net: NetworkConfig = {
        name: "custom",
        url: `http://${host}:9000`,
        authMode: "agent-token",
      };
      assert.doesNotThrow(() => assertLocalNetwork(net));
    }
  });

  it("rejects oauth networks", () => {
    const net: NetworkConfig = {
      name: "public",
      url: "https://api.robotnet.ai/v1",
      authMode: "oauth",
    };
    assert.throws(() => assertLocalNetwork(net), NotALocalNetworkError);
  });

  it("rejects agent-token networks pointing at non-loopback hosts", () => {
    const net: NetworkConfig = {
      name: "lan",
      url: "http://192.168.1.42:8723",
      authMode: "agent-token",
    };
    assert.throws(() => assertLocalNetwork(net), NotALocalNetworkError);
  });

  it("rejects unparseable URLs with a clear error", () => {
    const net: NetworkConfig = {
      name: "broken",
      url: "not-a-url",
      authMode: "agent-token",
    };
    assert.throws(() => assertLocalNetwork(net), /url is not parseable/);
  });
});

describe("networkPort", () => {
  it("returns explicit port", () => {
    const net: NetworkConfig = {
      name: "x",
      url: "http://127.0.0.1:9000",
      authMode: "agent-token",
    };
    assert.equal(networkPort(net), 9000);
  });

  it("falls back to 80/443 by scheme", () => {
    const http: NetworkConfig = {
      name: "x",
      url: "http://example.com",
      authMode: "agent-token",
    };
    const https: NetworkConfig = {
      name: "x",
      url: "https://example.com",
      authMode: "oauth",
    };
    assert.equal(networkPort(http), 80);
    assert.equal(networkPort(https), 443);
  });
});
