import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as assert from "node:assert/strict";
import {
  saveDaemonState,
  loadDaemonState,
  daemonStateToJson,
  epochMillis,
  type DaemonState,
} from "../src/daemon/state.js";

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "robotnet-test-"));
  return path.join(dir, "daemon.json");
}

describe("saveDaemonState / loadDaemonState", () => {
  it("round-trips state correctly", () => {
    const filePath = tmpFile();
    const state: DaemonState = {
      pid: 12345,
      health: "connected",
      websocketUrl: "wss://ws.test",
      clientId: "cid",
      agentRef: "@nick.me",
      lastEventAt: 1700000000000,
      lastError: null,
      updatedAt: 1700000001000,
      logFile: "/tmp/test.log",
    };
    saveDaemonState(filePath, state);
    const loaded = loadDaemonState(filePath);

    assert.deepStrictEqual(loaded, state);
  });

  it("handles null pid", () => {
    const filePath = tmpFile();
    const state: DaemonState = {
      pid: null,
      health: "stopped",
      websocketUrl: "wss://ws.test",
      clientId: "",
      agentRef: null,
      lastEventAt: null,
      lastError: "connection lost",
      updatedAt: 1700000000000,
      logFile: "/tmp/test.log",
    };
    saveDaemonState(filePath, state);
    const loaded = loadDaemonState(filePath);

    assert.deepStrictEqual(loaded, state);
  });

  it("returns null for missing file", () => {
    assert.equal(loadDaemonState("/tmp/nonexistent-robotnet.json"), null);
  });

  it("returns null for invalid JSON", () => {
    const filePath = tmpFile();
    fs.writeFileSync(filePath, "not json");
    assert.equal(loadDaemonState(filePath), null);
  });

  it("returns null for invalid health value", () => {
    const filePath = tmpFile();
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        pid: null,
        health: "invalid",
        websocket_url: "wss://test",
        client_id: "",
        updated_at: 123,
        log_file: "/tmp/test.log",
      }),
    );
    assert.equal(loadDaemonState(filePath), null);
  });

  it("returns null for missing updated_at", () => {
    const filePath = tmpFile();
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        pid: null,
        health: "stopped",
        websocket_url: "wss://test",
        client_id: "",
        log_file: "/tmp/test.log",
      }),
    );
    assert.equal(loadDaemonState(filePath), null);
  });

  it("writes files with restricted permissions", () => {
    const filePath = tmpFile();
    const state: DaemonState = {
      pid: null,
      health: "stopped",
      websocketUrl: "",
      clientId: "",
      agentRef: null,
      lastEventAt: null,
      lastError: null,
      updatedAt: epochMillis(),
      logFile: "",
    };
    saveDaemonState(filePath, state);
    const stats = fs.statSync(filePath);
    // 0o600 = owner read/write only
    assert.equal(stats.mode & 0o777, 0o600);
  });
});

describe("daemonStateToJson", () => {
  it("produces snake_case keys", () => {
    const state: DaemonState = {
      pid: 1,
      health: "connected",
      websocketUrl: "wss://test",
      clientId: "cid",
      agentRef: "@agent",
      lastEventAt: 123,
      lastError: null,
      updatedAt: 456,
      logFile: "/log",
    };
    const json = daemonStateToJson(state);
    assert.equal(json.websocket_url, "wss://test");
    assert.equal(json.client_id, "cid");
    assert.equal(json.agent_ref, "@agent");
    assert.equal(json.last_event_at, 123);
    assert.equal(json.updated_at, 456);
    assert.equal(json.log_file, "/log");
  });
});
