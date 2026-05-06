import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { Command } from "commander";

import { loadConfigForAgentCommand } from "../src/commands/asp-shared.js";
import { writeDirectoryIdentityEntry } from "../src/asp/identity.js";
import { RobotNetCLIError } from "../src/errors.js";
import { isolatedXdg } from "./helpers.js";

let env: ReturnType<typeof isolatedXdg>;
let originalCwd: string;
let originalAgentEnv: string | undefined;
let originalNetworkEnv: string | undefined;

beforeEach(() => {
  env = isolatedXdg();
  originalCwd = process.cwd();
  originalAgentEnv = process.env.ROBOTNET_AGENT;
  originalNetworkEnv = process.env.ROBOTNET_NETWORK;
  delete process.env.ROBOTNET_AGENT;
  delete process.env.ROBOTNET_NETWORK;
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalAgentEnv === undefined) {
    delete process.env.ROBOTNET_AGENT;
  } else {
    process.env.ROBOTNET_AGENT = originalAgentEnv;
  }
  if (originalNetworkEnv === undefined) {
    delete process.env.ROBOTNET_NETWORK;
  } else {
    process.env.ROBOTNET_NETWORK = originalNetworkEnv;
  }
  env.cleanup();
});

/** Build a leaf command nested inside a `agent` group inside a root, simulating commander's actual layout. */
function makeNestedLeaf(rootOpts: { profile?: string; network?: string } = {}): Command {
  const root = new Command();
  if (rootOpts.profile !== undefined) root.option("--profile <name>");
  if (rootOpts.network !== undefined) root.option("--network <name>");
  const group = new Command("session");
  const leaf = new Command("list");
  group.addCommand(leaf);
  root.addCommand(group);
  // commander parsed-opts shim: stash our options as if they were parsed.
  (root as unknown as { _optionValues: Record<string, unknown> })._optionValues =
    rootOpts;
  return leaf;
}

describe("loadConfigForAgentCommand", () => {
  it("network resolves from the directory identity file's default_network when no flag/env is set", async () => {
    const projectDir = fs.mkdtempSync(path.join(env.tmpDir, "proj-"));
    await writeDirectoryIdentityEntry(projectDir, {
      handle: "@cli.bot",
      network: "local",
    });
    process.chdir(projectDir);

    const leaf = makeNestedLeaf();
    const { config, identity } = await loadConfigForAgentCommand(leaf, undefined);

    assert.equal(config.network.name, "local");
    assert.equal(config.networkSource.kind, "directory_identity");
    assert.equal(identity.handle, "@cli.bot");
    assert.equal(identity.source, "directory");
  });

  it("explicit --network wins over the directory identity file's default_network", async () => {
    const projectDir = fs.mkdtempSync(path.join(env.tmpDir, "proj-"));
    await writeDirectoryIdentityEntry(projectDir, {
      handle: "@cli.bot",
      network: "local",
    });
    process.chdir(projectDir);

    const leaf = makeNestedLeaf({ network: "public" });
    // Identity for the flag-resolved network "public" is not in the
    // directory map, so without an env override this would fail to resolve.
    process.env.ROBOTNET_AGENT = "@env.bot";
    const { config, identity } = await loadConfigForAgentCommand(leaf, undefined);

    assert.equal(config.network.name, "public");
    assert.equal(config.networkSource.kind, "flag");
    assert.equal(identity.handle, "@env.bot");
    assert.equal(identity.source, "env");
  });

  it("ROBOTNET_NETWORK env wins over the directory identity file's default_network", async () => {
    const projectDir = fs.mkdtempSync(path.join(env.tmpDir, "proj-"));
    await writeDirectoryIdentityEntry(projectDir, {
      handle: "@cli.bot",
      network: "local",
    });
    process.chdir(projectDir);

    process.env.ROBOTNET_NETWORK = "public";
    process.env.ROBOTNET_AGENT = "@env.bot";

    const leaf = makeNestedLeaf();
    const { config } = await loadConfigForAgentCommand(leaf, undefined);

    assert.equal(config.network.name, "public");
    assert.equal(config.networkSource.kind, "env");
  });

  it("--as flag wins as the agent source and uses the resolved network", async () => {
    const projectDir = fs.mkdtempSync(path.join(env.tmpDir, "proj-"));
    await writeDirectoryIdentityEntry(projectDir, {
      handle: "@dir.bot",
      network: "local",
    });
    process.chdir(projectDir);

    const leaf = makeNestedLeaf();
    const { config, identity } = await loadConfigForAgentCommand(leaf, "@flag.bot");

    assert.equal(identity.handle, "@flag.bot");
    assert.equal(identity.source, "flag");
    // Resolved network still comes from the directory file's default_network.
    assert.equal(config.network.name, "local");
  });

  it("throws RobotNetCLIError when no agent identity is available for the resolved network", async () => {
    const isolated = fs.mkdtempSync(path.join(env.tmpDir, "isolated-"));
    process.chdir(isolated);
    const leaf = makeNestedLeaf();

    await assert.rejects(
      loadConfigForAgentCommand(leaf, undefined),
      (err: unknown) =>
        err instanceof RobotNetCLIError &&
        err.message.includes("no agent specified") &&
        err.message.includes("--as"),
    );
  });

  it("throws when the directory file has an entry for one network but the command targets another with no env/flag agent", async () => {
    const projectDir = fs.mkdtempSync(path.join(env.tmpDir, "proj-"));
    await writeDirectoryIdentityEntry(projectDir, {
      handle: "@local.bot",
      network: "local",
    });
    process.chdir(projectDir);

    const leaf = makeNestedLeaf({ network: "public" });
    await assert.rejects(
      loadConfigForAgentCommand(leaf, undefined),
      (err: unknown) =>
        err instanceof RobotNetCLIError &&
        err.message.includes('no agent specified for network "public"'),
    );
  });
});
