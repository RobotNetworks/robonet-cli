import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "../src/config.js";
import {
  loadStatus,
  readLogTail,
  resolveDaemonPaths,
} from "../src/daemon/manager.js";
import { saveDaemonState, type DaemonState } from "../src/daemon/state.js";
import { isolatedXdg } from "./helpers.js";

let env: ReturnType<typeof isolatedXdg>;

beforeEach(() => {
  env = isolatedXdg();
});

afterEach(() => {
  env.cleanup();
});

function makeState(
  overrides: Partial<DaemonState> = {},
): DaemonState {
  return {
    pid: null,
    health: "connected",
    websocketUrl: "wss://ws.example.test",
    clientId: "client_123",
    agentRef: "nuck.me",
    lastEventAt: null,
    lastError: null,
    updatedAt: 1,
    logFile: "/tmp/listener.log",
    ...overrides,
  };
}

describe("loadStatus", () => {
  it("converts stale pid to stopped", () => {
    const config = loadConfig();
    const paths = resolveDaemonPaths(config);

    // Write a state file with a PID that definitely isn't alive
    const state = makeState({ pid: 999999, logFile: paths.logFile });
    saveDaemonState(paths.stateFile, state);

    const result = loadStatus(config);

    assert.notEqual(result, null);
    assert.equal(result!.health, "stopped");
    assert.equal(result!.pid, null);
  });

  it("returns null when no state file exists", () => {
    const config = loadConfig();
    const result = loadStatus(config);
    assert.equal(result, null);
  });
});

describe("readLogTail", () => {
  it("returns last N lines", () => {
    const logFile = path.join(env.tmpDir, "listener.log");
    fs.writeFileSync(logFile, "a\nb\nc\n", "utf-8");

    const lines = readLogTail(logFile, 2);

    assert.deepEqual(lines, ["b", "c"]);
  });

  it("returns empty array when file missing", () => {
    assert.deepEqual(readLogTail("/tmp/nonexistent-log.log"), []);
  });
});
