import { describe, it } from "node:test";
import * as assert from "node:assert/strict";

import { Command } from "commander";

import { registerMailboxCommand } from "../src/commands/mailbox.js";

/**
 * Build the `mailbox` command tree and return either the parent or one
 * of its three subcommands. Each test grabs the subcommand it cares
 * about and pokes its parsed options after replacing the action with a
 * no-op, so nothing reaches the network.
 */
function buildMailbox(): Command {
  const program = new Command();
  program.exitOverride();
  registerMailboxCommand(program);
  const mailbox = program.commands.find((c) => c.name() === "mailbox");
  if (!mailbox) throw new Error("mailbox command not registered");
  mailbox.exitOverride();
  return mailbox;
}

function getSubcommand(name: "list" | "show" | "mark-read"): Command {
  const mailbox = buildMailbox();
  const sub = mailbox.commands.find((c) => c.name() === name);
  if (!sub) throw new Error(`mailbox ${name} not registered`);
  sub.exitOverride();
  // Replace the action so parsing never tries to hit the network or
  // open the credential store.
  sub.action(() => {});
  return sub;
}

function parseSub(name: "list" | "show" | "mark-read", args: readonly string[]): Command {
  const sub = getSubcommand(name);
  // `from: "user"` parses the literal argv with no `node script.js` stripping,
  // so each subcommand sees only the args meant for it.
  sub.parse([...args], { from: "user" });
  return sub;
}

const ID_A = "01KRSQFVPGWA7711W97J1WBCAQ";
const ID_B = "01KRSQFWAKR44K127N95W5V19C";
const ID_C = "01KRSQFWY1R5WHYK7TS9FAJ007";

describe("mailbox command tree", () => {
  it("registers the three documented subcommands", () => {
    const mailbox = buildMailbox();
    const names = mailbox.commands.map((c) => c.name()).sort();
    assert.deepEqual(names, ["list", "mark-read", "show"]);
  });
});

describe("mailbox show <ids...>", () => {
  it("accepts a single positional id", () => {
    const sub = parseSub("show", [ID_A]);
    assert.deepEqual(sub.args, [ID_A]);
  });

  it("accepts multiple space-separated ids", () => {
    const sub = parseSub("show", [ID_A, ID_B, ID_C]);
    assert.deepEqual(sub.args, [ID_A, ID_B, ID_C]);
  });

  it("does not swallow --as into the id list", () => {
    // Commander's variadic positional grammar greedily consumes until it
    // sees a flag, so this is the boundary case to lock down: a handle
    // option after the ids must survive intact.
    const sub = parseSub("show", [ID_A, ID_B, "--as", "@nick.assistant"]);
    assert.deepEqual(sub.args, [ID_A, ID_B]);
    assert.equal((sub.opts() as { as?: string }).as, "@nick.assistant");
  });
});

describe("mailbox mark-read <ids...>", () => {
  it("accepts a single positional id", () => {
    const sub = parseSub("mark-read", [ID_A]);
    assert.deepEqual(sub.args, [ID_A]);
  });

  it("accepts multiple space-separated ids", () => {
    const sub = parseSub("mark-read", [ID_A, ID_B, ID_C]);
    assert.deepEqual(sub.args, [ID_A, ID_B, ID_C]);
  });

  it("does not swallow --as into the id list", () => {
    const sub = parseSub("mark-read", [ID_A, ID_B, "--as", "@nick.assistant"]);
    assert.deepEqual(sub.args, [ID_A, ID_B]);
    assert.equal((sub.opts() as { as?: string }).as, "@nick.assistant");
  });
});

describe("mailbox list", () => {
  it("defaults --direction=in and --order=desc when neither flag is passed", () => {
    const sub = parseSub("list", []);
    const opts = sub.opts() as { direction: string; order: string; unread: boolean };
    assert.equal(opts.direction, "in");
    assert.equal(opts.order, "desc");
    assert.equal(opts.unread, false);
  });

  it("accepts the listing flags lifted from the old monolithic command", () => {
    const sub = parseSub("list", [
      "--direction",
      "out",
      "--order",
      "asc",
      "--limit",
      "5",
    ]);
    const opts = sub.opts() as { direction: string; order: string; limit: number };
    assert.equal(opts.direction, "out");
    assert.equal(opts.order, "asc");
    assert.equal(opts.limit, 5);
  });
});
