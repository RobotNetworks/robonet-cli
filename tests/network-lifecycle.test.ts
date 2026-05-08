import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig, type CLIConfig, type NetworkConfig } from "../src/config.js";
import { UnsafePlaintextEncryptor } from "../src/credentials/crypto.js";
import {
  _resetCredentialStoreCacheForTests,
  _setEncryptorForTests,
  openProcessCredentialStore,
} from "../src/credentials/lifecycle.js";
import {
  startNetwork,
  statusNetwork,
  stopNetwork,
} from "../src/network/lifecycle.js";
import { networkPaths } from "../src/network/paths.js";
import { readNetworkState } from "../src/network/state.js";
import { isolatedXdg } from "./helpers.js";

/* -------------------------------------------------------------------------- */
/* Test harness                                                                */
/* -------------------------------------------------------------------------- */

interface Harness {
  readonly cleanup: () => void;
  readonly config: CLIConfig;
}

/** Pick a free TCP port by binding to 0 and reading what the OS assigned. */
async function pickPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr === null || typeof addr === "string") {
        reject(new Error("could not get assigned port"));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

async function setupHarness(): Promise<Harness> {
  const xdg = isolatedXdg();
  const port = await pickPort();
  const baseConfig = loadConfig();
  const network: NetworkConfig = {
    name: "local",
    url: `http://127.0.0.1:${port}`,
    authMode: "agent-token",
  };
  const config: CLIConfig = {
    ...baseConfig,
    network,
    networks: { ...baseConfig.networks, local: network },
  };
  return { cleanup: xdg.cleanup, config };
}

/** Stop any running operator the harness might have left behind, swallowing errors. */
async function bestEffortStop(config: CLIConfig): Promise<void> {
  try {
    await stopNetwork(config);
  } catch {
    // ignore
  }
}

/** Path to the operator src so tests fork it directly via tsx (no build step).
 *
 * Use `fileURLToPath` rather than `URL.pathname` — on Windows, `pathname`
 * returns `/D:/a/...` (with a leading slash and drive letter), which
 * `path.resolve` mishandles.
 */
const OPERATOR_TS_ENTRYPOINT = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../src/operator/main.ts",
);

const TEST_START_OPTS = {
  operatorEntrypoint: OPERATOR_TS_ENTRYPOINT,
  nodeArgs: ["--import", "tsx"] as const,
  // Windows GitHub runners are noticeably slower at child-process spawn
  // + first `better-sqlite3` native binding load — 8s flakes on a cold
  // start. Give the operator a generous window; the test still fails
  // fast for genuine startup failures (synchronous spawn errors throw
  // before the readiness wait).
  readinessTimeoutMs: process.platform === "win32" ? 30_000 : 10_000,
};

/* -------------------------------------------------------------------------- */
/* Suites                                                                      */
/* -------------------------------------------------------------------------- */

describe("network lifecycle", () => {
  before(() => {
    _setEncryptorForTests(new UnsafePlaintextEncryptor());
  });
  after(() => {
    _setEncryptorForTests(null);
  });

  let harness: Harness;
  beforeEach(async () => {
    harness = await setupHarness();
  });
  afterEach(async () => {
    await bestEffortStop(harness.config);
    _resetCredentialStoreCacheForTests();
    harness.cleanup();
  });

  it("start → status → stop happy path", async () => {
    const { config } = harness;

    const started = await startNetwork(config, TEST_START_OPTS);
    assert.equal(started.adopted, false);
    assert.equal(started.state.network_name, "local");
    assert.equal(started.health.ok, true);
    assert.equal(started.health.network, "local");
    // The operator process is alive.
    assert.doesNotThrow(() => process.kill(started.state.pid, 0));

    const statusBefore = await statusNetwork(config);
    assert.notEqual(statusBefore, null);
    assert.equal(statusBefore?.state.pid, started.state.pid);
    assert.notEqual(statusBefore?.health, null);

    const stopped = await stopNetwork(config);
    assert.equal(stopped.stoppedPid, started.state.pid);
    assert.equal(stopped.killed, false);

    // State file is gone.
    const paths = networkPaths(config, "local");
    assert.equal(fs.existsSync(paths.stateFile), false);

    // Status now reports nothing running.
    assert.equal(await statusNetwork(config), null);
  });

  it("start writes admin token to credential store and adopt-on-restart preserves it", async () => {
    const { config } = harness;

    await startNetwork(config, TEST_START_OPTS);
    const store = await openProcessCredentialStore(config);
    const tokenA = store.getLocalAdminToken("local");
    assert.notEqual(tokenA, null);
    assert.equal(typeof tokenA?.token, "string");
    assert.ok((tokenA?.token.length ?? 0) > 20);

    // A second `start` while one is running adopts the existing operator;
    // the admin token in the store therefore must NOT be rotated underneath
    // the user (otherwise the in-flight operator's hash would mismatch).
    const second = await startNetwork(config, TEST_START_OPTS);
    assert.equal(second.adopted, true);
    const tokenB = store.getLocalAdminToken("local");
    assert.equal(tokenB?.token, tokenA?.token);
  });

  it("start cleans up a stale state file pointing at a dead PID", async () => {
    const { config } = harness;
    const paths = networkPaths(config, "local");
    fs.mkdirSync(path.dirname(paths.stateFile), { recursive: true });
    // PID 999999 is far above the typical max_pid range and reliably dead.
    const stale = {
      schema_version: 1,
      network_name: "local",
      host: "127.0.0.1",
      port: new URL(config.network.url).port
        ? Number.parseInt(new URL(config.network.url).port, 10)
        : 80,
      pid: 999_999,
      started_at_ms: Date.now() - 60_000,
      operator_version: "0.0.0",
      log_file: paths.logFile,
      database_file: paths.databaseFile,
    };
    fs.writeFileSync(paths.stateFile, JSON.stringify(stale), "utf-8");

    const result = await startNetwork(config, TEST_START_OPTS);
    assert.equal(result.adopted, false);
    assert.notEqual(result.state.pid, 999_999);

    const persisted = readNetworkState(paths.stateFile);
    assert.equal(persisted?.pid, result.state.pid);
  });

  it("status returns null and cleans up when the recorded PID is dead", async () => {
    const { config } = harness;
    const paths = networkPaths(config, "local");
    fs.mkdirSync(path.dirname(paths.stateFile), { recursive: true });
    fs.writeFileSync(
      paths.stateFile,
      JSON.stringify({
        schema_version: 1,
        network_name: "local",
        host: "127.0.0.1",
        port: 8723,
        pid: 999_999,
        started_at_ms: Date.now(),
        operator_version: "0.0.0",
        log_file: paths.logFile,
        database_file: paths.databaseFile,
      }),
      "utf-8",
    );
    assert.equal(await statusNetwork(config), null);
    assert.equal(fs.existsSync(paths.stateFile), false);
  });

  it("stop on a fresh harness throws NetworkNotRunningError", async () => {
    const { config } = harness;
    await assert.rejects(stopNetwork(config), /no local operator is running/i);
  });

  it("rejects supervising a non-local network", async () => {
    const { config } = harness;
    const remoteCfg: CLIConfig = {
      ...config,
      network: {
        name: "public",
        url: "https://api.robotnet.ai/v1",
        authMode: "oauth",
      },
    };
    await assert.rejects(
      startNetwork(remoteCfg, TEST_START_OPTS),
      /not a local network/i,
    );
  });

  it("start refuses to spawn when the configured port is already held by an untracked process", async () => {
    const { config } = harness;
    const url = new URL(config.network.url);
    const port = Number.parseInt(url.port, 10);
    // Stand up a dummy listener on the operator's configured port to
    // simulate an orphan operator (or any other unrelated process)
    // still bound after the supervisor lost track of it.
    const orphan = net.createServer();
    await new Promise<void>((resolve) =>
      orphan.listen(port, "127.0.0.1", resolve),
    );
    try {
      await assert.rejects(
        startNetwork(config, TEST_START_OPTS),
        (err: unknown) =>
          err instanceof Error &&
          err.name === "NetworkPortOccupiedError" &&
          err.message.includes(`127.0.0.1:${port}`) &&
          err.message.includes("network reset --yes"),
      );
      // The supervisor must NOT have written a state file or spawned a
      // child that races with our orphan — otherwise reset/cleanup
      // semantics get muddy.
      const paths = networkPaths(config, config.network.name);
      assert.equal(fs.existsSync(paths.stateFile), false);
    } finally {
      await new Promise<void>((resolve) => orphan.close(() => resolve()));
    }
  });
});
