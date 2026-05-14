import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  LOOKBACK_OVERLAP_MS,
  advanceWatermark,
  hasSeen,
  loadWatermark,
  saveWatermark,
  watermarkPath,
  watermarkToCursor,
} from "../src/asmtp/watermark.js";
import type { CLIConfig } from "../src/config.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "robotnet-watermark-test-"));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeConfig(): CLIConfig {
  return {
    profile: "default",
    profileSource: { kind: "default" },
    environment: "test",
    paths: {
      configDir: path.join(tmpDir, "config"),
      stateDir: tmpDir,
      logsDir: path.join(tmpDir, "logs"),
      runDir: path.join(tmpDir, "run"),
    },
    configFile: path.join(tmpDir, "config", "config.json"),
    tokenStoreFile: path.join(tmpDir, "token-store.json"),
    network: {
      name: "local",
      url: "http://127.0.0.1:8723",
      authMode: "agent-token",
      authBaseUrl: null,
      websocketUrl: null,
    },
    networkSource: { kind: "default" },
    networks: {},
  } as unknown as CLIConfig;
}

describe("watermarkPath", () => {
  it("places the file under <stateDir>/networks/<network>/watermarks/<handle-stem>.json", () => {
    const p = watermarkPath("/tmp/state", "local", "@me.dev");
    assert.equal(p, "/tmp/state/networks/local/watermarks/me.dev.json");
  });
});

describe("loadWatermark", () => {
  it("returns a fresh-install watermark when the file does not exist", async () => {
    const watermark = await loadWatermark(makeConfig(), "@me.dev");
    assert.equal(watermark.last_seen_created_at, 0);
    assert.equal(watermark.last_seen_envelope_id, null);
    assert.deepEqual(watermark.dedup_ids, {});
  });

  it("returns a fresh-install watermark on a corrupt file rather than throwing", async () => {
    const config = makeConfig();
    const target = watermarkPath(config.paths.stateDir, config.network.name, "@me.dev");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "{ not valid json", "utf8");
    const watermark = await loadWatermark(config, "@me.dev");
    assert.equal(watermark.last_seen_created_at, 0);
    assert.equal(watermark.last_seen_envelope_id, null);
  });

  it("round-trips through saveWatermark", async () => {
    const config = makeConfig();
    const original = {
      last_seen_created_at: 1747000000000,
      last_seen_envelope_id: "01HW7Z9KQX1MS2D9P5VC3GZ8AB",
      dedup_ids: { "01HW7Z9KQX1MS2D9P5VC3GZ8AB": 1747000000000 },
    };
    await saveWatermark(config, "@me.dev", original);
    const loaded = await loadWatermark(config, "@me.dev");
    assert.deepEqual(loaded, original);
  });
});

describe("advanceWatermark", () => {
  it("advances the cursor to the (created_at, envelope_id) max across inputs", () => {
    const start = {
      last_seen_created_at: 1000,
      last_seen_envelope_id: "01HW7Z9KQX1MS2D9P5VC3GZ8AB",
      dedup_ids: {},
    };
    const next = advanceWatermark(start, [
      { id: "01HW7Z9KQX1MS2D9P5VC3GZ8AC", created_at: 2000 },
      { id: "01HW7Z9KQX1MS2D9P5VC3GZ8AB", created_at: 1500 },
    ]);
    assert.equal(next.last_seen_created_at, 2000);
    assert.equal(next.last_seen_envelope_id, "01HW7Z9KQX1MS2D9P5VC3GZ8AC");
  });

  it("breaks millisecond ties by envelope id lex order", () => {
    const start = {
      last_seen_created_at: 0,
      last_seen_envelope_id: null,
      dedup_ids: {},
    };
    const next = advanceWatermark(start, [
      { id: "01HW7Z9KQX1MS2D9P5VC3GZ8AB", created_at: 1000 },
      { id: "01HW7Z9KQX1MS2D9P5VC3GZ8AC", created_at: 1000 },
    ]);
    assert.equal(next.last_seen_envelope_id, "01HW7Z9KQX1MS2D9P5VC3GZ8AC");
  });

  it("prunes dedup entries that fall below the 30s lookback window", () => {
    const start = {
      last_seen_created_at: 1000,
      last_seen_envelope_id: "01HW7Z9KQX1MS2D9P5VC3GZ8AB",
      dedup_ids: {
        old: 0,
        recent: 999,
      },
    };
    const next = advanceWatermark(start, [
      { id: "01HW7Z9KQX1MS2D9P5VC3GZ8AC", created_at: 1000 + LOOKBACK_OVERLAP_MS + 5_000 },
    ]);
    // `old` (created_at 0) is well below the new lookback floor; pruned.
    assert.equal("old" in next.dedup_ids, false);
    // `recent` is also below the floor; pruned.
    assert.equal("recent" in next.dedup_ids, false);
    // The newly seen id sits at the top; kept.
    assert.equal(
      "01HW7Z9KQX1MS2D9P5VC3GZ8AC" in next.dedup_ids,
      true,
    );
  });
});

describe("hasSeen + watermarkToCursor", () => {
  it("hasSeen reports true after advanceWatermark", () => {
    const advanced = advanceWatermark(
      {
        last_seen_created_at: 0,
        last_seen_envelope_id: null,
        dedup_ids: {},
      },
      [{ id: "01HW7Z9KQX1MS2D9P5VC3GZ8AB", created_at: 1000 }],
    );
    assert.equal(hasSeen(advanced, "01HW7Z9KQX1MS2D9P5VC3GZ8AB"), true);
    assert.equal(hasSeen(advanced, "01HW7Z9KQX1MS2D9P5VC3GZ8AC"), false);
  });

  it("watermarkToCursor returns null for a fresh-install watermark", () => {
    assert.equal(
      watermarkToCursor({
        last_seen_created_at: 0,
        last_seen_envelope_id: null,
        dedup_ids: {},
      }),
      null,
    );
  });

  it("watermarkToCursor returns the cursor pair when the watermark has advanced", () => {
    assert.deepEqual(
      watermarkToCursor({
        last_seen_created_at: 1000,
        last_seen_envelope_id: "01HW7Z9KQX1MS2D9P5VC3GZ8AB",
        dedup_ids: {},
      }),
      {
        created_at: 1000,
        envelope_id: "01HW7Z9KQX1MS2D9P5VC3GZ8AB",
      },
    );
  });
});
