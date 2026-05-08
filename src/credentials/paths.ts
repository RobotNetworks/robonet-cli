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
 * Path to the AES-256-GCM key file that protects the credential store.
 *
 * File format: a single line of base64 (32 raw bytes → 44 chars). Mode
 * `0600`, owner-only readable. Same threat model as `~/.ssh/id_rsa`.
 *
 * This is the default storage. Users who explicitly opt in via
 * `ROBOTNET_USE_KEYCHAIN=1` get the OS keychain instead — see
 * `keychain.ts`.
 */
export function credentialKeyFilePath(config: CLIConfig): string {
  return join(config.paths.configDir, "credential-store-key");
}
