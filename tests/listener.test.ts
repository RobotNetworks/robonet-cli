import { describe, it } from "node:test";
import * as assert from "node:assert/strict";

import {
  AuthenticationError,
  FatalAuthError,
  TransientAuthError,
} from "../src/errors.js";
import { listenForever } from "../src/realtime/listener.js";

describe("listenForever", () => {
  it("re-throws FatalAuthError without sleeping or reconnecting", async () => {
    let calls = 0;
    const stateUpdates: Array<{ health: string; lastError: string | null }> = [];

    await assert.rejects(
      listenForever({
        sessionFactory: async () => {
          calls += 1;
          throw new FatalAuthError("Refresh token family revoked");
        },
        logger: () => {},
        stateCallback: (health, _agent, lastError) => {
          stateUpdates.push({ health, lastError });
        },
      }),
      (err: unknown) => {
        assert.ok(err instanceof FatalAuthError);
        return true;
      },
    );

    assert.equal(calls, 1);
    assert.equal(
      stateUpdates.at(-1)?.health,
      "auth_failed",
      "final state should be auth_failed",
    );
    assert.match(stateUpdates.at(-1)?.lastError ?? "", /Refresh token family revoked/);
  });

  it("re-throws plain AuthenticationError (config errors) without retrying", async () => {
    // Simulates `runtime.ts` errors like missing token store or client_id mismatch.
    let calls = 0;
    const stateUpdates: string[] = [];

    await assert.rejects(
      listenForever({
        sessionFactory: async () => {
          calls += 1;
          throw new AuthenticationError(
            "No usable stored login found. Run `robotnet login` first.",
          );
        },
        logger: () => {},
        stateCallback: (health) => {
          stateUpdates.push(health);
        },
      }),
      (err: unknown) => err instanceof AuthenticationError,
    );

    assert.equal(calls, 1, "config errors should not be retried");
    assert.equal(stateUpdates.at(-1), "auth_failed");
  });

  it("retries with backoff on TransientAuthError, then exits on a fatal error", async () => {
    let calls = 0;
    const stateUpdates: string[] = [];

    const errors = [
      new TransientAuthError("upstream 503"),
      new TransientAuthError("upstream 429"),
      new FatalAuthError("Refresh token family revoked"),
    ];

    // Patch setTimeout to fire immediately so the test doesn't wait through real backoff.
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void) => {
      return originalSetTimeout(fn, 0);
    }) as typeof globalThis.setTimeout;

    try {
      await assert.rejects(
        listenForever({
          sessionFactory: async () => {
            const err = errors[calls++];
            if (!err) throw new Error("session factory called too many times");
            throw err;
          },
          logger: () => {},
          stateCallback: (health) => {
            stateUpdates.push(health);
          },
        }),
        (err: unknown) => err instanceof FatalAuthError,
      );
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }

    assert.equal(calls, 3, "should retry transient errors then exit on fatal");
    assert.ok(
      stateUpdates.includes("reconnecting"),
      "should pass through reconnecting on transient errors",
    );
    assert.equal(stateUpdates.at(-1), "auth_failed");
  });
});
