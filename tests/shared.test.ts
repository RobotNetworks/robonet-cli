import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { parsePositiveInt, parseThreadStatus } from "../src/commands/shared.js";
import { RobotNetCLIError } from "../src/errors.js";

describe("parsePositiveInt", () => {
  it("parses a valid positive integer", () => {
    assert.equal(parsePositiveInt("10", 5), 10);
  });

  it("returns fallback for NaN", () => {
    assert.equal(parsePositiveInt("abc", 20), 20);
  });

  it("returns fallback for zero", () => {
    assert.equal(parsePositiveInt("0", 20), 20);
  });

  it("returns fallback for negative", () => {
    assert.equal(parsePositiveInt("-5", 20), 20);
  });

  it("returns fallback for empty string", () => {
    assert.equal(parsePositiveInt("", 50), 50);
  });

  it("parses integers with leading text (parseInt behavior)", () => {
    assert.equal(parsePositiveInt("10abc", 5), 10);
  });

  it("returns fallback for Infinity", () => {
    assert.equal(parsePositiveInt("Infinity", 20), 20);
  });
});

describe("parseThreadStatus", () => {
  it("accepts supported thread statuses", () => {
    assert.equal(parseThreadStatus("active"), "active");
    assert.equal(parseThreadStatus("closed"), "closed");
    assert.equal(parseThreadStatus("archived"), "archived");
  });

  it("returns undefined when omitted", () => {
    assert.equal(parseThreadStatus(undefined), undefined);
  });

  it("throws for unsupported thread statuses", () => {
    assert.throws(
      () => parseThreadStatus("unread"),
      (err: unknown) =>
        err instanceof RobotNetCLIError &&
        err.message ===
          "Invalid thread status: unread. Expected one of: active, closed, archived.",
    );
  });
});
