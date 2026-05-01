import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { createRequire } from "node:module";
import { CLI_VERSION, USER_AGENT } from "../src/version.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

describe("version", () => {
  it("CLI_VERSION matches package.json", () => {
    assert.equal(CLI_VERSION, pkg.version);
  });

  it("USER_AGENT starts with robotnet-cli/<version>", () => {
    assert.match(USER_AGENT, new RegExp(`^robotnet-cli/${pkg.version.replace(/\./g, "\\.")}\\b`));
  });

  it("USER_AGENT includes node/<version> token", () => {
    assert.match(USER_AGENT, /\bnode\/v\d+\.\d+\.\d+/);
  });

  it("USER_AGENT includes a platform-arch token", () => {
    const expected = `${process.platform}-${process.arch}`;
    assert.ok(
      USER_AGENT.includes(expected),
      `expected USER_AGENT to include ${expected}, got: ${USER_AGENT}`,
    );
  });
});
