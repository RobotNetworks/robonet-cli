import { readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

import { networkStatePaths } from "../asp/credentials.js";
import { isValidHandle } from "../asp/handles.js";
import { loadToken, deleteToken } from "../auth/token-store.js";
import { CredentialDecryptionError } from "./aes-encryptor.js";
import type { CredentialStore } from "./store.js";

/**
 * One-time ingest of legacy file-based credentials into the SQLite store.
 *
 * Idempotent and cheap: skips rows that are already in the store, deletes
 * legacy files only after a successful insert, and walks no more than one
 * directory per known network. Safe to call on every store open — after
 * the first invocation that finds anything, subsequent runs are a few
 * filesystem stats.
 *
 * Removes successfully-migrated files. After one release where this code
 * has run for everyone, both this function and `src/asp/credentials.ts`'s
 * write helpers can be deleted.
 */
export async function migrateLegacyCredentials(args: {
  readonly store: CredentialStore;
  readonly profileStateDir: string;
  readonly networkNames: readonly string[];
  /**
   * Path to the legacy `auth.json` user-session file. When supplied, an
   * existing file will be ingested into the store's `user_sessions` table
   * (if not already populated) and removed from disk.
   */
  readonly legacyUserSessionFile?: string;
}): Promise<MigrationSummary> {
  const summary: MutableSummary = {
    adminTokensMigrated: 0,
    agentCredentialsMigrated: 0,
    userSessionsMigrated: 0,
  };

  for (const network of args.networkNames) {
    const paths = networkStatePaths(args.profileStateDir, network);

    // Decryption errors here mean the credential-store key was rotated and the
    // existing rows are unreadable. Don't fail migration — the per-command
    // self-heal path in `resolveAgentToken` / `resolveAdminToken` is what
    // surfaces the friendly recovery message and purges the bad rows. We
    // simply skip the "do we already have a row?" check and the migration
    // for this network; the next operation against it will trigger recovery.
    let hasExistingAdmin = false;
    try {
      hasExistingAdmin = args.store.getLocalAdminToken(network) !== null;
    } catch (err) {
      if (!(err instanceof CredentialDecryptionError)) throw err;
      continue;
    }
    if (!hasExistingAdmin) {
      const migrated = await migrateAdminToken(args.store, network, paths.adminTokenFile);
      if (migrated) summary.adminTokensMigrated += 1;
    }

    try {
      summary.agentCredentialsMigrated += await migrateAgentCredentials(
        args.store,
        network,
        paths.credentialsDir,
      );
    } catch (err) {
      if (!(err instanceof CredentialDecryptionError)) throw err;
      // Same recovery story — skip this network's agent credentials.
    }
  }

  if (
    args.legacyUserSessionFile !== undefined &&
    !args.store.hasUserSession() &&
    migrateLegacyUserSession(args.store, args.legacyUserSessionFile)
  ) {
    summary.userSessionsMigrated = 1;
  }

  return summary;
}

export interface MigrationSummary {
  readonly adminTokensMigrated: number;
  readonly agentCredentialsMigrated: number;
  readonly userSessionsMigrated: number;
}

interface MutableSummary {
  adminTokensMigrated: number;
  agentCredentialsMigrated: number;
  userSessionsMigrated: number;
}

/**
 * Pull a legacy `auth.json` (used for the user PKCE / client_credentials
 * session before the SQLite store landed) into `user_sessions`, then delete
 * the file. Returns `true` if a row was inserted.
 *
 * Best-effort: a corrupt or missing file just no-ops. The legacy
 * `expiresIn` field is dropped — it was a relative duration, and we don't
 * know the original mint time, so we leave `accessTokenExpiresAt` null and
 * let the auth server reject expired tokens on next use.
 */
function migrateLegacyUserSession(
  store: CredentialStore,
  filePath: string,
): boolean {
  const stored = loadToken(filePath);
  if (stored === null) return false;
  store.putUserSession({
    accessToken: stored.accessToken,
    refreshToken: stored.refreshToken ?? null,
    accessTokenExpiresAt: null,
    scope: stored.scope ?? null,
    clientId: stored.clientId,
    tokenEndpoint: stored.tokenEndpoint,
    resource: stored.resource,
    redirectUri: stored.redirectUri ?? null,
    authMode: stored.authMode,
  });
  deleteToken(filePath);
  return true;
}

async function migrateAdminToken(
  store: CredentialStore,
  network: string,
  filePath: string,
): Promise<boolean> {
  const token = await tryReadTrimmed(filePath);
  if (token === null) return false;
  store.putLocalAdminToken(network, token);
  await tryUnlink(filePath);
  return true;
}

async function migrateAgentCredentials(
  store: CredentialStore,
  network: string,
  credentialsDir: string,
): Promise<number> {
  let entries: readonly string[];
  try {
    entries = await readdir(credentialsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }

  let migrated = 0;
  for (const name of entries) {
    if (!name.endsWith(".token")) continue;
    const stem = name.slice(0, -".token".length);
    const handle = `@${stem}`;
    if (!isValidHandle(handle)) continue;
    if (store.getAgentCredential(network, handle) !== null) continue;

    const filePath = join(credentialsDir, name);
    const token = await tryReadTrimmed(filePath);
    if (token === null) continue;

    store.putAgentCredential({
      networkName: network,
      handle,
      kind: "local_bearer",
      bearer: token,
    });
    await tryUnlink(filePath);
    migrated += 1;
  }
  return migrated;
}

async function tryReadTrimmed(filePath: string): Promise<string | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function tryUnlink(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
