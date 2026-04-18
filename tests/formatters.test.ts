import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { renderKeyValues } from "../src/output/formatters.js";
import { renderJson } from "../src/output/json-output.js";

describe("renderKeyValues", () => {
  it("renders title and entries", () => {
    const result = renderKeyValues("Title", { key1: "val1", key2: 42 });
    assert.equal(result, "Title\n- key1: val1\n- key2: 42");
  });

  it("handles empty payload", () => {
    const result = renderKeyValues("Empty", {});
    assert.equal(result, "Empty");
  });

  it("handles null values", () => {
    const result = renderKeyValues("Test", { a: null });
    assert.equal(result, "Test\n- a: null");
  });
});

describe("renderJson", () => {
  it("pretty-prints JSON", () => {
    const result = renderJson({ key: "value", n: 1 });
    assert.equal(result, '{\n  "key": "value",\n  "n": 1\n}');
  });

  it("handles arrays", () => {
    const result = renderJson([1, 2, 3]);
    assert.equal(result, "[\n  1,\n  2,\n  3\n]");
  });

  it("handles null", () => {
    assert.equal(renderJson(null), "null");
  });
});
