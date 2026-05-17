import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  collectNetworkStatuses,
  formatStatusesHuman,
  formatStatusesJson,
  type NetworkStatus,
  type ReachabilityProbe,
  type StoredHandlesProbe,
} from "../src/commands/status.js";
import { writeDirectoryIdentityEntry } from "../src/asmtp/identity.js";
import { loadConfig } from "../src/config.js";
import { isolatedXdg } from "./helpers.js";

let env: ReturnType<typeof isolatedXdg>;
let originalCwd: string;
let originalAgentEnv: string | undefined;

beforeEach(() => {
  env = isolatedXdg();
  originalCwd = process.cwd();
  originalAgentEnv = process.env.ROBOTNET_AGENT;
  delete process.env.ROBOTNET_AGENT;
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalAgentEnv === undefined) {
    delete process.env.ROBOTNET_AGENT;
  } else {
    process.env.ROBOTNET_AGENT = originalAgentEnv;
  }
  env.cleanup();
});

/** Reachability probe that returns whichever boolean was queued for each URL. */
function fixedProbe(table: Record<string, boolean>): ReachabilityProbe {
  return async (url) => table[url] ?? false;
}

/** Stored-handles probe that returns whichever array was queued per network. */
function fixedStoredHandles(
  table: Record<string, readonly string[]> = {},
): StoredHandlesProbe {
  return async (networkName) => table[networkName] ?? [];
}

/** Empty stored-handles probe — the common case for tests that don't care. */
const noStoredHandles: StoredHandlesProbe = async () => [];

describe("collectNetworkStatuses", () => {
  it("reports each configured network with reachability and resolved identity", async () => {
    const projectDir = fs.mkdtempSync(path.join(env.tmpDir, "proj-"));
    await writeDirectoryIdentityEntry(projectDir, {
      handle: "@me.dev",
      network: "local",
    });
    process.chdir(projectDir);

    const config = loadConfig();
    const probe = fixedProbe({
      "http://127.0.0.1:8723": true,
      "https://api.robotnet.works/v1": false,
    });
    const statuses = await collectNetworkStatuses(config, probe, noStoredHandles);

    const byName = Object.fromEntries(statuses.map((s) => [s.name, s]));
    assert.equal(byName.local!.reachable, true);
    assert.equal(byName.local!.identity?.handle, "@me.dev");
    assert.equal(byName.local!.identity?.source, "directory");
    assert.deepEqual(byName.local!.storedHandles, []);
    assert.equal(byName.global!.reachable, false);
    assert.equal(byName.global!.identity, null);
    assert.deepEqual(byName.global!.storedHandles, []);
  });

  it("returns networks sorted by name for stable output", async () => {
    process.chdir(env.tmpDir);
    const config = loadConfig();
    const probe: ReachabilityProbe = async () => true;
    const statuses = await collectNetworkStatuses(config, probe, noStoredHandles);
    const names = statuses.map((s) => s.name);
    const sorted = [...names].sort();
    assert.deepEqual(names, sorted);
  });

  it("env-set ROBOTNET_AGENT applies to every network with no directory binding", async () => {
    process.env.ROBOTNET_AGENT = "@env.bot";
    process.chdir(env.tmpDir);

    const config = loadConfig();
    const statuses = await collectNetworkStatuses(
      config,
      fixedProbe({
        "http://127.0.0.1:8723": true,
        "https://api.robotnet.works/v1": true,
      }),
      noStoredHandles,
    );
    for (const s of statuses) {
      assert.equal(s.identity?.handle, "@env.bot");
      assert.equal(s.identity?.source, "env");
    }
  });

  it("directory-only identity does not bleed into other networks", async () => {
    const projectDir = fs.mkdtempSync(path.join(env.tmpDir, "proj-"));
    await writeDirectoryIdentityEntry(projectDir, {
      handle: "@local.bot",
      network: "local",
    });
    process.chdir(projectDir);

    const config = loadConfig();
    const statuses = await collectNetworkStatuses(
      config,
      fixedProbe({
        "http://127.0.0.1:8723": true,
        "https://api.robotnet.works/v1": true,
      }),
      noStoredHandles,
    );
    const byName = Object.fromEntries(statuses.map((s) => [s.name, s]));
    assert.equal(byName.local!.identity?.handle, "@local.bot");
    assert.equal(byName.global!.identity, null);
  });

  it("stored handles are populated per network and sorted", async () => {
    process.chdir(env.tmpDir);
    const config = loadConfig();
    const statuses = await collectNetworkStatuses(
      config,
      fixedProbe({
        "http://127.0.0.1:8723": true,
        "https://api.robotnet.works/v1": true,
      }),
      fixedStoredHandles({
        local: ["@nick.workbench", "@nick.assistant"],
        global: ["@nick.soa"],
      }),
    );
    const byName = Object.fromEntries(statuses.map((s) => [s.name, s]));
    assert.deepEqual(byName.local!.storedHandles, [
      "@nick.assistant",
      "@nick.workbench",
    ]);
    assert.deepEqual(byName.global!.storedHandles, ["@nick.soa"]);
  });
});

describe("formatStatusesHuman", () => {
  const status = (over: Partial<NetworkStatus>): NetworkStatus => ({
    name: "local",
    url: "http://127.0.0.1:8723",
    authMode: "agent-token",
    reachable: true,
    identity: null,
    storedHandles: [],
    ...over,
  });

  it("emits one [robotnet]-prefixed line per live network with an identity", () => {
    const lines = formatStatusesHuman([
      status({
        name: "local",
        identity: { handle: "@me.dev", source: "directory" },
      }),
      status({
        name: "global",
        url: "https://api.robotnet.works/v1",
        authMode: "oauth",
        identity: { handle: "@me.prod", source: "directory" },
      }),
    ]);
    assert.deepEqual(lines, [
      "[robotnet] local: @me.dev",
      "[robotnet] global: @me.prod",
    ]);
  });

  it("marks live networks without an identity and without stored credentials", () => {
    const lines = formatStatusesHuman([
      status({ name: "local", identity: null, storedHandles: [] }),
    ]);
    assert.deepEqual(lines, ["[robotnet] local: reachable, no identity"]);
  });

  it("surfaces stored credentials when no active identity resolved", () => {
    const lines = formatStatusesHuman([
      status({
        name: "global",
        url: "https://api.robotnet.works/v1",
        authMode: "oauth",
        identity: null,
        storedHandles: ["@nick.soa"],
      }),
    ]);
    assert.deepEqual(lines, [
      "[robotnet] global: reachable, no active identity (stored: @nick.soa)",
    ]);
  });

  it("lists every stored handle when several are logged in", () => {
    const lines = formatStatusesHuman([
      status({
        name: "global",
        url: "https://api.robotnet.works/v1",
        authMode: "oauth",
        identity: null,
        storedHandles: ["@nick.assistant", "@nick.workbench"],
      }),
    ]);
    assert.deepEqual(lines, [
      "[robotnet] global: reachable, no active identity (stored: @nick.assistant, @nick.workbench)",
    ]);
  });

  it("prefers the active identity over stored credentials when both are present", () => {
    // Stored credentials are listable via `--as` but the active identity is
    // what default commands will use, so surfacing both in the same line
    // adds noise without changing how the user thinks about the network.
    const lines = formatStatusesHuman([
      status({
        name: "global",
        url: "https://api.robotnet.works/v1",
        authMode: "oauth",
        identity: { handle: "@nick.soa", source: "directory" },
        storedHandles: ["@nick.assistant", "@nick.soa"],
      }),
    ]);
    assert.deepEqual(lines, ["[robotnet] global: @nick.soa"]);
  });

  it("skips dead networks entirely", () => {
    const lines = formatStatusesHuman([
      status({ name: "local", reachable: false }),
      status({
        name: "global",
        reachable: true,
        identity: { handle: "@me.prod", source: "env" },
      }),
    ]);
    assert.deepEqual(lines, ["[robotnet] global: @me.prod"]);
  });

  it("returns no lines when nothing is live", () => {
    const lines = formatStatusesHuman([
      status({ name: "local", reachable: false }),
      status({ name: "global", reachable: false }),
    ]);
    assert.deepEqual(lines, []);
  });
});

describe("formatStatusesJson", () => {
  it("serializes a stable snake_case envelope including stored_handles", () => {
    const json = formatStatusesJson([
      {
        name: "local",
        url: "http://127.0.0.1:8723",
        authMode: "agent-token",
        reachable: true,
        identity: { handle: "@me.dev", source: "directory" },
        storedHandles: ["@me.dev"],
      },
    ]);
    assert.deepEqual(JSON.parse(json), {
      networks: [
        {
          name: "local",
          url: "http://127.0.0.1:8723",
          auth_mode: "agent-token",
          reachable: true,
          identity: { handle: "@me.dev", source: "directory" },
          stored_handles: ["@me.dev"],
        },
      ],
    });
  });

  it("renders identity:null and stored_handles:[] when neither is present", () => {
    const json = formatStatusesJson([
      {
        name: "local",
        url: "http://127.0.0.1:8723",
        authMode: "agent-token",
        reachable: true,
        identity: null,
        storedHandles: [],
      },
    ]);
    const parsed = JSON.parse(json).networks[0];
    assert.equal(parsed.identity, null);
    assert.deepEqual(parsed.stored_handles, []);
  });
});
