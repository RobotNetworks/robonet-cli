import type { CLIConfig } from "../config.js";
import type { Encryptor } from "./crypto.js";
import { buildProductionEncryptor } from "./keychain.js";
import { migrateLegacyCredentials } from "./migration.js";
import { credentialsStorePath } from "./paths.js";
import { CredentialStore } from "./store.js";

/**
 * Per-process cached store. The CLI is short-lived and almost every action
 * touches credentials at most twice; opening the DB once amortises the
 * legacy-migration sweep, the keychain key fetch, and WAL setup.
 *
 * Tests should call {@link _setEncryptorForTests} with a plaintext encryptor
 * so they never touch the real OS keychain. Without that, the first store
 * open in any test process would mint and persist a key under
 * `com.robotnet.cli/credential-store-key`.
 */
let cached: { config: CLIConfig; store: CredentialStore } | null = null;
let migrationPromise: Promise<void> | null = null;
let encryptorOverride: Encryptor | null = null;

export async function openProcessCredentialStore(
  config: CLIConfig,
): Promise<CredentialStore> {
  if (cached !== null && cached.config === config) {
    if (migrationPromise !== null) await migrationPromise;
    return cached.store;
  }
  if (cached !== null) {
    cached.store.close();
    cached = null;
    migrationPromise = null;
  }

  const encryptor =
    encryptorOverride ?? (await buildProductionEncryptor({ accountName: config.profile }));
  const store = CredentialStore.open(credentialsStorePath(config), { encryptor });
  cached = { config, store };

  migrationPromise = migrateLegacyCredentials({
    store,
    profileStateDir: config.paths.stateDir,
    networkNames: Object.keys(config.networks),
    legacyUserSessionFile: config.tokenStoreFile,
  }).then(() => undefined);

  await migrationPromise;
  return store;
}

/**
 * Inject an encryptor for tests, replacing the production keychain-backed
 * one. Tests should set this in `beforeEach` so each case starts from a
 * predictable state. Real CLI invocations should never call this.
 */
export function _setEncryptorForTests(encryptor: Encryptor | null): void {
  encryptorOverride = encryptor;
  // The cached store keeps its existing encryptor; reset so the next
  // open() picks up the override.
  if (cached !== null) {
    cached.store.close();
    cached = null;
    migrationPromise = null;
  }
}

/**
 * For tests: drop any cached store. Real CLI invocations are short-lived
 * enough that we don't expose a public close method.
 */
export function _resetCredentialStoreCacheForTests(): void {
  if (cached !== null) {
    cached.store.close();
    cached = null;
  }
  migrationPromise = null;
}
