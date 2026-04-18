import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { Command } from "commander";

import { registerThreadsCommand } from "../src/commands/threads.js";
import { RoboNetCLIError } from "../src/errors.js";

describe("threads command", () => {
  it("rejects unsupported thread status filters before making API calls", async () => {
    const program = new Command();
    program.option("--profile <name>");
    registerThreadsCommand(program);

    await assert.rejects(
      () =>
        program.parseAsync([
          "node",
          "robonet",
          "threads",
          "list",
          "--status",
          "unread",
        ]),
      (err: unknown) =>
        err instanceof RoboNetCLIError &&
        err.message ===
          "Invalid thread status: unread. Expected one of: active, closed, archived.",
    );
  });
});
