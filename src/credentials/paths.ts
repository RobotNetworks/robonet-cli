import { join } from "node:path";

import type { CLIConfig } from "../config.js";

/**
 * Resolve the SQLite credential store path for this profile.
 *
 * Lives next to today's `auth.json` for now: `<configDir>/credentials.sqlite`.
 * When the Mac app picks up the same store, it must use this path; named
 * profiles nest under `profiles/<name>/credentials.sqlite` automatically
 * because `configDir` already encodes the profile.
 */
export function credentialsStorePath(config: CLIConfig): string {
  return join(config.paths.configDir, "credentials.sqlite");
}
