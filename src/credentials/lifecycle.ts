import type { CLIConfig } from "../config.js";
import type { Encryptor } from "./crypto.js";
import { buildFileBackedEncryptor } from "./file-key.js";
import { migrateLegacyCredentials } from "./migration.js";
import { credentialKeyFilePath, credentialsStorePath } from "./paths.js";
import { CredentialStore } from "./store.js";

/**
 * Per-process cached store. The CLI is short-lived and almost every action
 * touches credentials at most twice; opening the DB once amortises the
 * legacy-migration sweep, the key fetch, and WAL setup.
 *
 * The cache key is `(profile, db path)` — a stable string tuple — not the
 * caller's `CLIConfig` object identity. Several command handlers load the
 * config more than once per invocation (e.g. via
 * `loadConfigForAgentCommand` followed by `loadConfigFromRoot`); each call
 * builds a fresh `CLIConfig` object. Two configs that resolve to the same
 * profile and db path are functionally equivalent and must share the
 * underlying store.
 *
 * Tests should call {@link _setEncryptorForTests} with a plaintext
 * encryptor so they never write a key file under `~/.config/robotnet/`.
 */
interface CachedStore {
  readonly key: string;
  readonly store: CredentialStore;
  readonly migration: Promise<void>;
}

let cached: CachedStore | null = null;
let encryptorOverride: Encryptor | null = null;

function cacheKey(config: CLIConfig): string {
  return `${config.profile} ${credentialsStorePath(config)}`;
}

export async function openProcessCredentialStore(
  config: CLIConfig,
): Promise<CredentialStore> {
  const key = cacheKey(config);
  if (cached !== null && cached.key === key) {
    await cached.migration;
    return cached.store;
  }
  if (cached !== null) {
    cached.store.close();
    cached = null;
  }

  const encryptor =
    encryptorOverride ??
    buildFileBackedEncryptor({ keyFilePath: credentialKeyFilePath(config) });
  const store = CredentialStore.open(credentialsStorePath(config), { encryptor });
  const migration = migrateLegacyCredentials({
    store,
    profileStateDir: config.paths.stateDir,
    networkNames: Object.keys(config.networks),
    legacyUserSessionFile: config.tokenStoreFile,
  }).then(() => undefined);

  cached = { key, store, migration };
  await migration;
  return store;
}

/**
 * Inject an encryptor for tests, replacing the production one. Tests should
 * set this in `beforeEach` so each case starts from a predictable state.
 * Real CLI invocations should never call this.
 */
export function _setEncryptorForTests(encryptor: Encryptor | null): void {
  encryptorOverride = encryptor;
  if (cached !== null) {
    cached.store.close();
    cached = null;
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
}
