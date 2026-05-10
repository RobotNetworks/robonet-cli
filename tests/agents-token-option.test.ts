import { describe, it } from "node:test";
import * as assert from "node:assert/strict";

import { Command } from "commander";

import {
  registerAgentsCommand,
  registerMeCommand,
  registerSearchCommand,
} from "../src/commands/agents.js";

function buildProgram(): Command {
  const program = new Command();
  registerMeCommand(program);
  registerAgentsCommand(program);
  registerSearchCommand(program);
  return program;
}

function helpFor(program: Command, ...path: string[]): string {
  let cmd: Command | undefined = program;
  for (const segment of path) {
    cmd = cmd?.commands.find((c) => c.name() === segment);
    if (cmd === undefined) {
      throw new Error(`subcommand path not found: ${path.join(" ")}`);
    }
  }
  return cmd!.helpInformation();
}

describe("--token escape hatch on agent-bearer commands", () => {
  // Regression for the omission discovered in CLI_MANUAL_TEST_PLAN.md §13.11:
  // the plan documented `me show --token <bearer>` as the bypass-the-store
  // escape hatch, but the option was never wired through. session/files/listen
  // already had it; the agent-self surface (me/agents) was the gap.
  const surfaces: ReadonlyArray<readonly string[]> = [
    ["me", "show"],
    ["me", "update"],
    ["me", "allowlist", "list"],
    ["me", "allowlist", "add"],
    ["me", "allowlist", "remove"],
    ["me", "block"],
    ["me", "unblock"],
    ["me", "blocks"],
    ["agents", "show"],
    ["agents", "card"],
    ["agents", "search"],
    ["search"],
  ];

  for (const path of surfaces) {
    it(`exposes --token on \`${path.join(" ")}\``, () => {
      const program = buildProgram();
      const help = helpFor(program, ...path);
      assert.match(help, /--token <token>/, `help for ${path.join(" ")} missing --token`);
    });
  }
});
