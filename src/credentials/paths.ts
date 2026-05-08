import { join } from "node:path";

import type { CLIConfig } from "../config.js";

/**
 * Resolve the SQLite credential store path for this profile.
 *
 * Lives next to today's `auth.json` for now: `<configDir>/credentials.sqlite`.
 * Other RobotNet clients must use this path; named
 * profiles nest under `profiles/<name>/credentials.sqlite` automatically
 * because `configDir` already encodes the profile.
 */
export function credentialsStorePath(config: CLIConfig): string {
  return join(config.paths.configDir, "credentials.sqlite");
}

/**
 * Path to the AES-256-GCM key that protects the credential store.
 * Single line of base64 (32 raw bytes → 44 chars), mode `0600`, owner-
 * only readable. Same threat model as `~/.ssh/id_rsa`.
 */
export function credentialKeyFilePath(config: CLIConfig): string {
  return join(config.paths.configDir, "credential-store-key");
}
