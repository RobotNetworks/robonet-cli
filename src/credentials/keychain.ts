import { Entry } from "@napi-rs/keyring";

import { RobotNetCLIError } from "../errors.js";
import { AesGcmEncryptor } from "./aes-encryptor.js";
import { UnsafePlaintextEncryptor, type Encryptor } from "./crypto.js";

/**
 * Where the credential-store key lives in the OS keychain. Tracked here so
 * a `robotnet logout --all` (in the future) can call `entry.deletePassword()`
 * to wipe it cleanly.
 */
const KEYCHAIN_SERVICE = "com.robotnet.cli";
const KEYCHAIN_ACCOUNT_DEFAULT = "credential-store-key";

/**
 * Provision an {@link Encryptor} backed by an AES-256-GCM key stored in the
 * OS keychain (Keychain on macOS, Secret Service on Linux, Credential
 * Manager on Windows — all surfaced through @napi-rs/keyring).
 *
 * On first call: generates a fresh key, persists it to the keychain, and
 * returns an encryptor.
 * On subsequent calls: reads the key from the keychain.
 *
 * If the keychain is unavailable (a headless Linux box without
 * gnome-keyring, for example), this **degrades to plaintext** with a single
 * stderr warning. The threat model on a headless machine is different
 * anyway — file mode 0600 is the only protection — and we'd rather have
 * a working CLI than a hard failure on `dbus` not being present.
 *
 * `accountName` lets named profiles get their own key (so a `--profile work`
 * compromise can't decrypt the `default` profile).
 */
export async function buildProductionEncryptor(opts: {
  readonly accountName?: string;
  /** Override the underlying keychain entry constructor; lets tests inject a fake. */
  readonly entryFactory?: (service: string, account: string) => KeychainEntry;
  /** Sink for the "keychain unavailable" warning. Defaults to process.stderr.write. */
  readonly warn?: (message: string) => void;
} = {}): Promise<Encryptor> {
  const account = opts.accountName ?? KEYCHAIN_ACCOUNT_DEFAULT;
  const entry = opts.entryFactory
    ? opts.entryFactory(KEYCHAIN_SERVICE, account)
    : new Entry(KEYCHAIN_SERVICE, account);
  const warn = opts.warn ?? ((m: string) => process.stderr.write(m));

  let storedB64: string | null = null;
  try {
    storedB64 = entry.getPassword();
  } catch (err) {
    warn(
      `robotnet: warning: OS keychain unavailable (${err instanceof Error ? err.message : String(err)}); ` +
        `secrets stored in plaintext mode 0600. ` +
        `On macOS/Windows this should never happen; on headless Linux, install gnome-keyring or run inside dbus-run-session.\n`,
    );
    return new UnsafePlaintextEncryptor();
  }

  if (storedB64 !== null && storedB64.length > 0) {
    let key: Buffer;
    try {
      key = Buffer.from(storedB64, "base64");
    } catch {
      throw new RobotNetCLIError(
        `keychain entry for ${KEYCHAIN_SERVICE}/${account} is not valid base64 — refusing to use a corrupt key`,
      );
    }
    return AesGcmEncryptor.fromKey(key);
  }

  const fresh = AesGcmEncryptor.generateKey();
  try {
    entry.setPassword(fresh.toString("base64"));
  } catch (err) {
    warn(
      `robotnet: warning: could not persist credential-store key to OS keychain ` +
        `(${err instanceof Error ? err.message : String(err)}); secrets stored in plaintext mode 0600.\n`,
    );
    return new UnsafePlaintextEncryptor();
  }
  return AesGcmEncryptor.fromKey(fresh);
}

/**
 * Minimal contract @napi-rs/keyring's `Entry` implements. Re-declared here
 * so tests can supply a fake without depending on the native module.
 */
export interface KeychainEntry {
  getPassword(): string | null;
  setPassword(value: string): void;
  deletePassword(): boolean;
}
