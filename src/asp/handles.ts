import { RobotNetCLIError } from "../errors.js";

/**
 * Handle and allowlist-entry validation.
 *
 * Patterns are vendored from `asp/schemas/common.json` (`$defs/Handle`,
 * `$defs/AllowlistEntry`) at the same ASP version this CLI implements.
 * Failing fast at parse time — well before a request reaches the network —
 * surfaces a clear "your input is malformed" message instead of a downstream
 * `agent_not_found` from the server.
 */

const HANDLE_PATTERN = /^@[a-z0-9_-]+\.[a-z0-9_-]+$/;
const ALLOWLIST_ENTRY_PATTERN = /^@[a-z0-9_-]+\.([a-z0-9_-]+|\*)$/;

export class InvalidHandleError extends RobotNetCLIError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidHandleError";
  }
}

export function isValidHandle(value: unknown): value is string {
  return typeof value === "string" && HANDLE_PATTERN.test(value);
}

export function isValidAllowlistEntry(value: unknown): value is string {
  return typeof value === "string" && ALLOWLIST_ENTRY_PATTERN.test(value);
}

export function assertValidHandle(value: string): void {
  if (!HANDLE_PATTERN.test(value)) {
    throw new InvalidHandleError(
      `invalid handle "${value}" (expected @<owner>.<name> with lowercase ` +
        `letters, digits, underscore, or hyphen in each part)`,
    );
  }
}

export function assertValidAllowlistEntry(value: string): void {
  if (!ALLOWLIST_ENTRY_PATTERN.test(value)) {
    throw new InvalidHandleError(
      `invalid allowlist entry "${value}" (expected @<owner>.<name> or @<owner>.*)`,
    );
  }
}

/** commander `argParser` for a single `<handle>` argument. */
export function handleArg(value: string): string {
  assertValidHandle(value);
  return value;
}

/** commander `argParser` for a variadic `<handles...>` argument. */
export function handlesArg(
  value: string,
  previous: readonly string[] | undefined,
): string[] {
  assertValidHandle(value);
  return previous === undefined ? [value] : [...previous, value];
}

/** commander `argParser` for a variadic `<entries...>` allowlist argument. */
export function allowlistEntriesArg(
  value: string,
  previous: readonly string[] | undefined,
): string[] {
  assertValidAllowlistEntry(value);
  return previous === undefined ? [value] : [...previous, value];
}

/** Strip the leading `@` so the handle can be embedded in a filesystem path. */
export function handleToFilenameStem(handle: string): string {
  assertValidHandle(handle);
  return handle.slice(1);
}
