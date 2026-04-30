import { createRequire } from "node:module";

/**
 * Single source of truth for the CLI's version and User-Agent string.
 *
 * Reading `package.json` via `createRequire` rather than via an ESM JSON
 * import keeps us compatible with Node 18, the minimum runtime version
 * declared in CONTRIBUTING.md. ESM JSON import attributes are stable in
 * Node 22+ but flag-gated on 18/20.
 */

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version?: unknown };

if (typeof pkg.version !== "string" || pkg.version.length === 0) {
  throw new Error(
    "package.json is missing a usable `version` field — refusing to start.",
  );
}

export const CLI_VERSION: string = pkg.version;

/**
 * User-Agent string sent on every outbound HTTP request from the CLI.
 *
 * Format follows the convention established by npm, aws-cli, and other
 * widely-used CLIs: a primary product token followed by platform tokens.
 * Server-side request logs use this for forensics — for example,
 * identifying which Node.js versions or operating systems trip over a
 * specific issue, or bucketing analytics by client surface without
 * overloading any other field.
 *
 * Example: `robotnet-cli/0.1.6 node/v22.10.0 darwin-arm64`
 */
export const USER_AGENT: string = `robotnet-cli/${CLI_VERSION} node/${process.version} ${process.platform}-${process.arch}`;
