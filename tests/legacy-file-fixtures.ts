import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { networkStatePaths } from "../src/asmtp/credentials.js";
import { handleToFilenameStem } from "../src/asmtp/handles.js";

/**
 * Test-only helpers that recreate the on-disk shape `src/asmtp/credentials.ts`
 * used to write before the SQLite credential store landed.
 *
 * These exist solely so migration tests can simulate "user upgrades from a
 * version that wrote tokens to per-network files." Production code never
 * calls these — it writes through `CredentialStore`.
 */

export async function writeLegacyAdminToken(
  profileStateDir: string,
  networkName: string,
  token: string,
): Promise<string> {
  const paths = networkStatePaths(profileStateDir, networkName);
  await mkdir(paths.networkDir, { recursive: true });
  await writeFile(paths.adminTokenFile, token, { encoding: "utf8", mode: 0o600 });
  return paths.adminTokenFile;
}

export async function writeLegacyAgentCredential(
  profileStateDir: string,
  networkName: string,
  handle: string,
  token: string,
): Promise<string> {
  const paths = networkStatePaths(profileStateDir, networkName);
  await mkdir(paths.credentialsDir, { recursive: true });
  const filePath = join(paths.credentialsDir, `${handleToFilenameStem(handle)}.token`);
  await writeFile(filePath, token, { encoding: "utf8", mode: 0o600 });
  return filePath;
}
