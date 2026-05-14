import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { AsmtpApiError } from "../src/asmtp/errors.js";

describe("AsmtpApiError.message", () => {
  it("leads with the operator's structured code when present", () => {
    const err = new AsmtpApiError(404, "NOT_FOUND", { detail: "not found" });
    assert.equal(err.message, "NOT_FOUND: not found");
  });

  it("renders 'HTTP <status>' when the server didn't emit a structured code", () => {
    const err = new AsmtpApiError(502, "http_502", { detail: "bad gateway" });
    assert.equal(err.message, "HTTP 502: bad gateway");
  });

  it("omits detail hint when none is supplied", () => {
    const err = new AsmtpApiError(403, "ACCESS_DENIED");
    assert.equal(err.message, "ACCESS_DENIED");
  });

  it("formats FastAPI-style validation arrays into human-readable lines", () => {
    const err = new AsmtpApiError(422, "VALIDATION_ERROR", {
      detail: [
        { loc: ["query", "limit"], msg: "ensure this value is greater than 0" },
      ],
    });
    assert.equal(
      err.message,
      "VALIDATION_ERROR: query.limit: ensure this value is greater than 0",
    );
  });

  it("preserves explicit message overrides", () => {
    const err = new AsmtpApiError(409, "CONFLICT", {
      message: "envelope already accepted",
    });
    assert.equal(err.message, "envelope already accepted");
  });
});
