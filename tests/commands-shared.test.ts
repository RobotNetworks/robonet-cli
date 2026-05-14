import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { readStringOrFile } from "../src/commands/shared.js";
import { RobotNetCLIError } from "../src/errors.js";

describe("readStringOrFile", () => {
  it("returns literal text unchanged", () => {
    assert.equal(readStringOrFile("hello world", "--description"), "hello world");
  });

  it("preserves the empty string (callers interpret it as 'clear')", () => {
    assert.equal(readStringOrFile("", "--description"), "");
  });

  it("reads UTF-8 file contents when prefixed with @", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rbnx-shared-"));
    try {
      const filePath = path.join(dir, "card.md");
      fs.writeFileSync(filePath, "# Title\n\nMulti-line\nbody\n", "utf8");
      const result = readStringOrFile(`@${filePath}`, "--card-body");
      assert.equal(result, "# Title\n\nMulti-line\nbody\n");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects bare @ with a helpful error", () => {
    assert.throws(
      () => readStringOrFile("@", "--card-body"),
      (err) =>
        err instanceof RobotNetCLIError &&
        err.message.includes("--card-body") &&
        err.message.includes("file path"),
    );
  });

  it("wraps fs errors in RobotNetCLIError mentioning the flag + path", () => {
    const missing = path.join(os.tmpdir(), `rbnx-shared-missing-${Date.now()}.txt`);
    assert.throws(
      () => readStringOrFile(`@${missing}`, "--description"),
      (err) =>
        err instanceof RobotNetCLIError &&
        err.message.includes("--description") &&
        err.message.includes(missing),
    );
  });
});
