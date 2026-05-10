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
} from "../src/commands/status.js";
import { writeDirectoryIdentityEntry } from "../src/asp/identity.js";
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
    const statuses = await collectNetworkStatuses(config, probe);

    const byName = Object.fromEntries(statuses.map((s) => [s.name, s]));
    assert.equal(byName.local!.reachable, true);
    assert.equal(byName.local!.identity?.handle, "@me.dev");
    assert.equal(byName.local!.identity?.source, "directory");
    assert.equal(byName.global!.reachable, false);
    assert.equal(byName.global!.identity, null);
  });

  it("returns networks sorted by name for stable output", async () => {
    process.chdir(env.tmpDir);
    const config = loadConfig();
    const probe: ReachabilityProbe = async () => true;
    const statuses = await collectNetworkStatuses(config, probe);
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
    );
    const byName = Object.fromEntries(statuses.map((s) => [s.name, s]));
    assert.equal(byName.local!.identity?.handle, "@local.bot");
    assert.equal(byName.global!.identity, null);
  });
});

describe("formatStatusesHuman", () => {
  const status = (over: Partial<NetworkStatus>): NetworkStatus => ({
    name: "local",
    url: "http://127.0.0.1:8723",
    authMode: "agent-token",
    reachable: true,
    identity: null,
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

  it("marks live networks without an identity", () => {
    const lines = formatStatusesHuman([
      status({ name: "local", identity: null }),
    ]);
    assert.deepEqual(lines, ["[robotnet] local: reachable, no identity"]);
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
  it("serializes a stable snake_case envelope", () => {
    const json = formatStatusesJson([
      {
        name: "local",
        url: "http://127.0.0.1:8723",
        authMode: "agent-token",
        reachable: true,
        identity: { handle: "@me.dev", source: "directory" },
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
        },
      ],
    });
  });

  it("renders identity:null when no identity resolved", () => {
    const json = formatStatusesJson([
      {
        name: "local",
        url: "http://127.0.0.1:8723",
        authMode: "agent-token",
        reachable: true,
        identity: null,
      },
    ]);
    assert.equal(JSON.parse(json).networks[0].identity, null);
  });
});
