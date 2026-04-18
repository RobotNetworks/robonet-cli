import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  isRetryableStatus,
  isRetryableNetworkError,
  withRetry,
} from "../src/retry.js";

describe("isRetryableStatus", () => {
  it("retries on 429", () => {
    assert.equal(isRetryableStatus(429), true);
  });

  it("retries on 502", () => {
    assert.equal(isRetryableStatus(502), true);
  });

  it("retries on 503", () => {
    assert.equal(isRetryableStatus(503), true);
  });

  it("retries on 504", () => {
    assert.equal(isRetryableStatus(504), true);
  });

  it("does not retry on 400", () => {
    assert.equal(isRetryableStatus(400), false);
  });

  it("does not retry on 401", () => {
    assert.equal(isRetryableStatus(401), false);
  });

  it("does not retry on 404", () => {
    assert.equal(isRetryableStatus(404), false);
  });

  it("does not retry on 500", () => {
    assert.equal(isRetryableStatus(500), false);
  });
});

describe("isRetryableNetworkError", () => {
  it("retries TypeError (fetch network error)", () => {
    assert.equal(isRetryableNetworkError(new TypeError("fetch failed")), true);
  });

  it("retries DOMException TimeoutError", () => {
    const err = new DOMException("signal timed out", "TimeoutError");
    assert.equal(isRetryableNetworkError(err), true);
  });

  it("does not retry generic Error", () => {
    assert.equal(isRetryableNetworkError(new Error("something")), false);
  });

  it("does not retry non-TimeoutError DOMException", () => {
    const err = new DOMException("aborted", "AbortError");
    assert.equal(isRetryableNetworkError(err), false);
  });
});

describe("withRetry", () => {
  it("returns result on first success", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      return "ok";
    });
    assert.equal(result, "ok");
    assert.equal(calls, 1);
  });

  it("retries on TypeError and succeeds", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls === 1) throw new TypeError("fetch failed");
        return "recovered";
      },
      { maxRetries: 2, initialDelayMs: 1 },
    );
    assert.equal(result, "recovered");
    assert.equal(calls, 2);
  });

  it("exhausts retries and throws", async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        withRetry(
          async () => {
            calls++;
            throw new TypeError("fetch failed");
          },
          { maxRetries: 1, initialDelayMs: 1 },
        ),
      TypeError,
    );
    assert.equal(calls, 2); // initial + 1 retry
  });

  it("does not retry non-retryable errors", async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        withRetry(
          async () => {
            calls++;
            throw new Error("non-retryable");
          },
          { maxRetries: 2, initialDelayMs: 1 },
        ),
      Error,
    );
    assert.equal(calls, 1);
  });
});
