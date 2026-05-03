import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { Command } from "commander";

import { loadConfigForAgentCommand } from "../src/commands/asp-shared.js";
import { writeDirectoryIdentity } from "../src/asp/identity.js";
import { RobotNetCLIError } from "../src/errors.js";
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

/** Build a leaf command nested inside a `agent` group inside a root, simulating commander's actual layout. */
function makeNestedLeaf(rootOpts: { profile?: string; network?: string } = {}): Command {
  const root = new Command();
  if (rootOpts.profile !== undefined) root.option("--profile <name>");
  if (rootOpts.network !== undefined) root.option("--network <name>");
  // Apply via parseAsync semantics by setting the parsed opts directly.
  // commander stores parsed values; to avoid an actual parse, create children
  // and manually push the parent chain.
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
  it("uses the directory identity's network when --network is unset", async () => {
    const projectDir = fs.mkdtempSync(path.join(env.tmpDir, "proj-"));
    await writeDirectoryIdentity(projectDir, {
      handle: "@cli.bot",
      network: "local",
    });
    process.chdir(projectDir);

    const leaf = makeNestedLeaf();
    const { config, identity } = await loadConfigForAgentCommand(leaf, undefined);

    assert.equal(config.network.name, "local");
    assert.equal(identity.handle, "@cli.bot");
    assert.equal(identity.source, "directory");
  });

  it("explicit --network wins over the directory identity's network", async () => {
    const projectDir = fs.mkdtempSync(path.join(env.tmpDir, "proj-"));
    await writeDirectoryIdentity(projectDir, {
      handle: "@cli.bot",
      network: "local",
    });
    process.chdir(projectDir);

    const leaf = makeNestedLeaf({ network: "robotnet" });
    const { config } = await loadConfigForAgentCommand(leaf, undefined);

    assert.equal(config.network.name, "robotnet");
  });

  it("--as flag wins as the agent source and uses the resolved network", async () => {
    const projectDir = fs.mkdtempSync(path.join(env.tmpDir, "proj-"));
    await writeDirectoryIdentity(projectDir, {
      handle: "@dir.bot",
      network: "local",
    });
    process.chdir(projectDir);

    const leaf = makeNestedLeaf();
    const { config, identity } = await loadConfigForAgentCommand(leaf, "@flag.bot");

    // Identity source = flag → handle is the flag's, but the resolved network
    // is still the directory's because --network wasn't provided.
    assert.equal(identity.handle, "@flag.bot");
    assert.equal(identity.source, "flag");
    assert.equal(config.network.name, "local");
  });

  it("throws RobotNetCLIError when no agent identity is available", async () => {
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
});
