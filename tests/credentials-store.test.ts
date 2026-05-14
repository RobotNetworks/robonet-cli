import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { CredentialStore } from "../src/credentials/store.js";

let tmpDir: string;
let store: CredentialStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rbnx-creds-"));
  store = CredentialStore.open(path.join(tmpDir, "credentials.sqlite"));
});

afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("CredentialStore.deleteAgentCredentialsForNetwork", () => {
  it("removes every credential bound to the named network, returning the row count", () => {
    store.putAgentCredential({
      networkName: "local",
      handle: "@a.bot",
      kind: "local_bearer",
      bearer: "t1",
    });
    store.putAgentCredential({
      networkName: "local",
      handle: "@b.bot",
      kind: "local_bearer",
      bearer: "t2",
    });
    // Different network: must not be touched.
    store.putAgentCredential({
      networkName: "dev",
      handle: "@c.bot",
      kind: "local_bearer",
      bearer: "t3",
    });

    const removed = store.deleteAgentCredentialsForNetwork("local");
    assert.equal(removed, 2);

    assert.equal(store.getAgentCredential("local", "@a.bot"), null);
    assert.equal(store.getAgentCredential("local", "@b.bot"), null);
    // The 'dev' credential survives untouched.
    const survivor = store.getAgentCredential("dev", "@c.bot");
    assert.ok(survivor !== null);
    assert.equal(survivor!.handle, "@c.bot");
  });

  it("returns 0 when the network has no credentials", () => {
    assert.equal(store.deleteAgentCredentialsForNetwork("never-used"), 0);
  });
});
