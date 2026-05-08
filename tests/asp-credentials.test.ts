import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as path from "node:path";

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
    // The implementation joins via `node:path`, which is platform-native:
    // forward slashes on POSIX, backslashes on Windows. Build the
    // expected paths the same way so the test is cross-platform.
    const stateDir = path.join(path.sep, "tmp", "rbnx-state");
    const networkDir = path.join(stateDir, "networks", "local");
    const p = networkStatePaths(stateDir, "local");
    assert.equal(p.networkDir, networkDir);
    assert.equal(p.adminTokenFile, path.join(networkDir, "admin.token"));
    assert.equal(p.credentialsDir, path.join(networkDir, "credentials"));
    assert.equal(p.networkInfoFile, path.join(networkDir, "network.json"));
    assert.equal(p.pidFile, path.join(networkDir, "asp.pid"));
    assert.equal(p.sqliteFile, path.join(networkDir, "asp.sqlite"));
    assert.equal(
      p.serverLogFile,
      path.join(networkDir, "logs", "server.log"),
    );
  });

  it("rejects invalid network names early", () => {
    assert.throws(
      () => networkStatePaths("/tmp", "Bad/Name"),
      InvalidNetworkNameError,
    );
  });
});
