import { describe, it } from "node:test";
import * as assert from "node:assert/strict";

import {
  InvalidHandleError,
  allowlistEntriesArg,
  assertValidAllowlistEntry,
  assertValidHandle,
  handleArg,
  handleToFilenameStem,
  handlesArg,
  isValidAllowlistEntry,
  isValidHandle,
} from "../src/asp/handles.js";

describe("isValidHandle", () => {
  it("accepts canonical @owner.name handles", () => {
    assert.equal(isValidHandle("@cli.bot"), true);
    assert.equal(isValidHandle("@migration.bot"), true);
    assert.equal(isValidHandle("@a-b_c.x_y-z"), true);
    assert.equal(isValidHandle("@1.2"), true);
  });

  it("rejects malformed handles", () => {
    for (const bad of [
      "cli.bot", // missing @
      "@cli", // missing dot
      "@cli.", // empty name
      "@.bot", // empty owner
      "@CLI.bot", // uppercase
      "@cli.bot ", // trailing space
      "@cli.bot.bot", // extra segment
      "@cli/bot",
      "",
      42,
      null,
      undefined,
    ]) {
      assert.equal(isValidHandle(bad), false, `should reject ${JSON.stringify(bad)}`);
    }
  });
});

describe("isValidAllowlistEntry", () => {
  it("accepts handles and owner globs", () => {
    assert.equal(isValidAllowlistEntry("@acme.support"), true);
    assert.equal(isValidAllowlistEntry("@acme.*"), true);
    assert.equal(isValidAllowlistEntry("@a-b.*"), true);
  });

  it("rejects globbed owner", () => {
    assert.equal(isValidAllowlistEntry("@*.foo"), false);
    assert.equal(isValidAllowlistEntry("*.bot"), false);
  });
});

describe("assertValid* throw InvalidHandleError on bad input", () => {
  it("assertValidHandle", () => {
    assert.throws(() => assertValidHandle("CLI.bot"), InvalidHandleError);
  });
  it("assertValidAllowlistEntry", () => {
    assert.throws(
      () => assertValidAllowlistEntry("@*.bot"),
      InvalidHandleError,
    );
  });
});

describe("handleArg / handlesArg / allowlistEntriesArg (commander coercers)", () => {
  it("handleArg returns the value when valid", () => {
    assert.equal(handleArg("@cli.bot"), "@cli.bot");
  });

  it("handlesArg accumulates valid handles into a fresh array", () => {
    const a = handlesArg("@a.b", undefined);
    assert.deepEqual(a, ["@a.b"]);
    const b = handlesArg("@c.d", a);
    assert.deepEqual(b, ["@a.b", "@c.d"]);
    // Original is left untouched — coercer must be pure on its input.
    assert.deepEqual(a, ["@a.b"]);
  });

  it("allowlistEntriesArg accepts globs", () => {
    const out = allowlistEntriesArg("@acme.*", undefined);
    assert.deepEqual(out, ["@acme.*"]);
  });

  it("each coercer rejects malformed inputs with InvalidHandleError", () => {
    assert.throws(() => handleArg("nope"), InvalidHandleError);
    assert.throws(() => handlesArg("nope", undefined), InvalidHandleError);
    assert.throws(() => allowlistEntriesArg("nope", undefined), InvalidHandleError);
  });
});

describe("handleToFilenameStem", () => {
  it("strips the leading @ for filesystem use", () => {
    assert.equal(handleToFilenameStem("@cli.bot"), "cli.bot");
    assert.equal(handleToFilenameStem("@migration.bot"), "migration.bot");
  });

  it("rejects an invalid handle rather than producing a garbage stem", () => {
    assert.throws(() => handleToFilenameStem("nope"), InvalidHandleError);
  });
});
