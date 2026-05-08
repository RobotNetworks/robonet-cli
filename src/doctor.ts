import * as fs from "node:fs";

import { Entry } from "@napi-rs/keyring";

import { discoverOAuth } from "./auth/discovery.js";
import { findDirectoryIdentityFile } from "./asp/identity.js";
import type { CLIConfig } from "./config.js";
import { UnsafePlaintextEncryptor } from "./credentials/crypto.js";
import { credentialKeyFilePath, credentialsStorePath } from "./credentials/paths.js";
import { CredentialStore } from "./credentials/store.js";
import { DISCOVERY_TIMEOUT_MS } from "./endpoints.js";

/**
 * Result of a single diagnostic check: stable machine-readable `name`,
 * pass/fail `ok`, and a human-readable `detail`.
 */
export interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

/**
 * Run the full diagnostic suite. Never throws — every probe converts errors
 * into `ok: false` entries so the caller can render a complete report even
 * when individual checks fail.
 */
export async function runDoctor(config: CLIConfig): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  checks.push(configPathsCheck(config));
  checks.push(networkInfoCheck(config));
  checks.push(await networkReachabilityCheck(config));
  checks.push(credentialStoreCheck(config));
  checks.push(credentialKeyBackendCheck(config));
  checks.push(await directoryIdentityCheck());
  if (config.network.authMode === "oauth") {
    checks.push(await oauthDiscoveryCheck(config));
    checks.push(storedUserSessionCheck(config));
  }
  return checks;
}

function configPathsCheck(config: CLIConfig): DoctorCheck {
  return {
    name: "config_paths",
    ok: true,
    detail:
      `config=${config.paths.configDir} ` +
      `state=${config.paths.stateDir} ` +
      `logs=${config.paths.logsDir} ` +
      `run=${config.paths.runDir}`,
  };
}

function networkInfoCheck(config: CLIConfig): DoctorCheck {
  return {
    name: "network",
    ok: true,
    detail:
      `name=${config.network.name} ` +
      `url=${config.network.url} ` +
      `auth_mode=${config.network.authMode} ` +
      `source=${config.networkSource.kind}`,
  };
}

async function networkReachabilityCheck(config: CLIConfig): Promise<DoctorCheck> {
  const url = config.network.url.replace(/\/+$/, "");
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      redirect: "follow",
    });
    // Any HTTP response means the server is up. Network errors (DNS, TCP
    // refused, timeout) are the only "unreachable" signal we care about.
    return {
      name: "network_reachable",
      ok: true,
      detail: `${url} status=${response.status}`,
    };
  } catch (err) {
    return {
      name: "network_reachable",
      ok: false,
      detail: `${url} error=${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function credentialStoreCheck(config: CLIConfig): DoctorCheck {
  const path = credentialsStorePath(config);
  if (!fs.existsSync(path)) {
    return {
      name: "credential_store",
      ok: true,
      detail: `not yet created at ${path} (created on first \`admin agent create\`, \`account login\`, or \`login\`)`,
    };
  }

  // Use the plaintext encryptor — doctor only needs schema version and
  // counts, never the secret values themselves. Avoids touching the OS
  // keychain on every doctor run.
  let store: CredentialStore;
  try {
    store = CredentialStore.open(path, { encryptor: new UnsafePlaintextEncryptor() });
  } catch (err) {
    return {
      name: "credential_store",
      ok: false,
      detail: `${path} error=${err instanceof Error ? err.message : String(err)}`,
    };
  }
  try {
    return {
      name: "credential_store",
      ok: true,
      detail:
        `${path} schema_version=${store.schemaVersion} ` +
        `local_admin_tokens=${store.countLocalAdminTokens()} ` +
        `agent_credentials=${store.countAgentCredentials()}`,
    };
  } finally {
    store.close();
  }
}

function credentialKeyBackendCheck(config: CLIConfig): DoctorCheck {
  const useKeychain =
    (process.env["ROBOTNET_USE_KEYCHAIN"] ?? "").trim() === "1";

  if (useKeychain) {
    try {
      const entry = new Entry("com.robotnet.cli", config.profile);
      const present = entry.getPassword() !== null;
      return {
        name: "credential_key",
        ok: true,
        detail:
          `backend=keychain (ROBOTNET_USE_KEYCHAIN=1) ` +
          `service=com.robotnet.cli account=${config.profile} ` +
          (present
            ? `key=present`
            : `key=not yet minted (next login/agent create will create it)`),
      };
    } catch (err) {
      return {
        name: "credential_key",
        ok: false,
        detail:
          `backend=keychain (ROBOTNET_USE_KEYCHAIN=1) ` +
          `unavailable: ${err instanceof Error ? err.message : String(err)}.`,
      };
    }
  }

  const keyFile = credentialKeyFilePath(config);
  const exists = fs.existsSync(keyFile);
  if (!exists) {
    return {
      name: "credential_key",
      ok: true,
      detail:
        `backend=file path=${keyFile} key=not yet minted ` +
        `(next login/agent create will create at mode 0600)`,
    };
  }
  let modeOctal = "?";
  try {
    const stat = fs.statSync(keyFile);
    modeOctal = (stat.mode & 0o777).toString(8).padStart(4, "0");
  } catch {
    // best-effort
  }
  const ok = modeOctal === "0600";
  return {
    name: "credential_key",
    ok,
    detail: ok
      ? `backend=file path=${keyFile} mode=${modeOctal}`
      : `backend=file path=${keyFile} mode=${modeOctal} (expected 0600 — ` +
        `run \`chmod 600 ${keyFile}\` to lock down)`,
  };
}

async function directoryIdentityCheck(): Promise<DoctorCheck> {
  try {
    const file = await findDirectoryIdentityFile();
    if (!file) {
      return {
        name: "directory_identity",
        ok: true,
        detail: "no .robotnet/config.json in cwd or any ancestor",
      };
    }
    const bindingPart =
      file.agent !== undefined
        ? ` agent=${file.agent} bound_to=${file.network ?? "(none)"}`
        : " agent=(none)";
    return {
      name: "directory_identity",
      ok: true,
      detail: `${file.filePath}${bindingPart}`,
    };
  } catch (err) {
    return {
      name: "directory_identity",
      ok: false,
      detail: `error reading directory identity: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function oauthDiscoveryCheck(config: CLIConfig): Promise<DoctorCheck> {
  try {
    const discovery = await discoverOAuth(config.network);
    return {
      name: "oauth_discovery",
      ok: true,
      detail:
        `token_endpoint=${discovery.tokenEndpoint} ` +
        `api_resource=${discovery.apiResource ?? "n/a"} ` +
        `websocket_resource=${discovery.websocketResource ?? "n/a"}`,
    };
  } catch (err) {
    return {
      name: "oauth_discovery",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function storedUserSessionCheck(config: CLIConfig): DoctorCheck {
  const path = credentialsStorePath(config);
  if (!fs.existsSync(path)) {
    return {
      name: "stored_user_session",
      ok: false,
      detail: "no credential store yet — run `robotnet login`",
    };
  }
  // Read non-secret metadata via the plaintext encryptor; we never decrypt
  // the actual access/refresh tokens here.
  let store: CredentialStore;
  try {
    store = CredentialStore.open(path, { encryptor: new UnsafePlaintextEncryptor() });
  } catch (err) {
    return {
      name: "stored_user_session",
      ok: false,
      detail: `${path} error=${err instanceof Error ? err.message : String(err)}`,
    };
  }
  try {
    const info = store.getUserSessionInfo();
    if (info === null) {
      return {
        name: "stored_user_session",
        ok: false,
        detail: "no user session in the credential store — run `robotnet login`",
      };
    }
    return {
      name: "stored_user_session",
      ok: true,
      detail:
        `auth_mode=${info.authMode} ` +
        `client_id=${info.clientId ?? "n/a"} ` +
        `resource=${info.resource ?? "n/a"} ` +
        `token_endpoint=${info.tokenEndpoint}`,
    };
  } finally {
    store.close();
  }
}
