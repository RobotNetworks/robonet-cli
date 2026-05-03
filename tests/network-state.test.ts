import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { CorruptNetworkStateError } from "../src/network/errors.js";
import {
  STATE_FILE_VERSION,
  deleteNetworkState,
  readNetworkState,
  writeNetworkState,
  type NetworkState,
} from "../src/network/state.js";

function tmpStateFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "robotnet-network-state-"));
  return path.join(dir, "network.json");
}

function sample(): NetworkState {
  return {
    schema_version: STATE_FILE_VERSION,
    network_name: "local",
    host: "127.0.0.1",
    port: 8723,
    pid: 1234,
    started_at_ms: Date.now(),
    operator_version: "0.1.0",
    log_file: "/tmp/operator.log",
    database_file: "/tmp/operator.sqlite",
  };
}

describe("network state file", () => {
  it("round-trips a valid state", () => {
    const file = tmpStateFile();
    const state = sample();
    writeNetworkState(file, state);
    assert.deepEqual(readNetworkState(file), state);
  });

  it("readNetworkState returns null for a missing file", () => {
    const file = tmpStateFile();
    assert.equal(readNetworkState(file), null);
  });

  it("readNetworkState throws for malformed JSON", () => {
    const file = tmpStateFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{not json");
    assert.throws(() => readNetworkState(file), CorruptNetworkStateError);
  });

  it("readNetworkState throws when required fields are missing", () => {
    const file = tmpStateFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ schema_version: 1 }));
    assert.throws(() => readNetworkState(file), CorruptNetworkStateError);
  });

  it("readNetworkState rejects schema_version newer than this CLI", () => {
    const file = tmpStateFile();
    const state = { ...sample(), schema_version: STATE_FILE_VERSION + 1 };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state));
    assert.throws(
      () => readNetworkState(file),
      /Upgrade the CLI/,
    );
  });

  it("deleteNetworkState is a no-op for a missing file", () => {
    const file = tmpStateFile();
    assert.doesNotThrow(() => deleteNetworkState(file));
  });

  it("write writes mode 0600 (POSIX only)", { skip: process.platform === "win32" }, () => {
    const file = tmpStateFile();
    writeNetworkState(file, sample());
    const mode = fs.statSync(file).mode & 0o777;
    assert.equal(mode, 0o600);
  });
});
