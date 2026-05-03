import { describe, it } from "node:test";
import * as assert from "node:assert/strict";

import {
  InvalidNetworkNameError,
  assertValidNetworkName,
  networkStatePaths,
} from "../src/asp/credentials.js";

describe("assertValidNetworkName", () => {
  it("accepts canonical names", () => {
    for (const name of ["local", "robotnet", "staging-2", "ci_run", "a"]) {
      assert.doesNotThrow(() => assertValidNetworkName(name));
    }
  });

  it("rejects invalid names", () => {
    for (const name of ["", "Local", "-local", "_local", "a/b", "a.b", "a".repeat(65)]) {
      assert.throws(
        () => assertValidNetworkName(name),
        InvalidNetworkNameError,
        `should reject ${JSON.stringify(name)}`,
      );
    }
  });
});

describe("networkStatePaths", () => {
  it("nests every artifact under <stateDir>/networks/<name>/", () => {
    const p = networkStatePaths("/tmp/rbnx-state", "local");
    assert.equal(p.networkDir, "/tmp/rbnx-state/networks/local");
    assert.equal(p.adminTokenFile, "/tmp/rbnx-state/networks/local/admin.token");
    assert.equal(p.credentialsDir, "/tmp/rbnx-state/networks/local/credentials");
    assert.equal(p.networkInfoFile, "/tmp/rbnx-state/networks/local/network.json");
    assert.equal(p.pidFile, "/tmp/rbnx-state/networks/local/asp.pid");
    assert.equal(p.sqliteFile, "/tmp/rbnx-state/networks/local/asp.sqlite");
    assert.equal(p.serverLogFile, "/tmp/rbnx-state/networks/local/logs/server.log");
  });

  it("rejects invalid network names early", () => {
    assert.throws(
      () => networkStatePaths("/tmp", "Bad/Name"),
      InvalidNetworkNameError,
    );
  });
});
