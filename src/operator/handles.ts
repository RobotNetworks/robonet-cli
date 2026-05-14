import { BadRequestError } from "./errors.js";

/**
 * Handle and allowlist-entry validation, vendored from the network's
 * wire-level handle and allowlist shapes.
 *
 * Independent of the CLI-side `src/asmtp/handles.ts` so the operator can
 * later be lifted into its own package without dragging the CLI's error
 * hierarchy along. Errors thrown here are {@link BadRequestError} so they
 * map straight to a 400 response.
 */

const HANDLE_PATTERN = /^@[a-z0-9_-]+\.[a-z0-9_-]+$/;
const ALLOWLIST_ENTRY_PATTERN = /^@[a-z0-9_-]+\.([a-z0-9_-]+|\*)$/;

export function isHandle(value: unknown): value is string {
  return typeof value === "string" && HANDLE_PATTERN.test(value);
}

export function isAllowlistEntry(value: unknown): value is string {
  return typeof value === "string" && ALLOWLIST_ENTRY_PATTERN.test(value);
}

export function assertHandle(value: unknown, field = "handle"): string {
  if (!isHandle(value)) {
    throw new BadRequestError(
      `${field} must match @<owner>.<name> (got ${JSON.stringify(value)})`,
      "INVALID_HANDLE",
    );
  }
  return value;
}

export function assertAllowlistEntry(value: unknown, field = "entry"): string {
  if (!isAllowlistEntry(value)) {
    throw new BadRequestError(
      `${field} must match @<owner>.<name> or @<owner>.* (got ${JSON.stringify(value)})`,
      "INVALID_ALLOWLIST_ENTRY",
    );
  }
  return value;
}
