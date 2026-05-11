import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { CLIConfig } from "../config.js";
import { RobotNetCLIError } from "../errors.js";

const LOCK_WAIT_MS = 65_000;
const STALE_LOCK_MS = 120_000;
const BASE_RETRY_MS = 25;
const MAX_RETRY_MS = 250;

export interface CredentialRefreshLockKey {
  readonly kind: "agent" | "user";
  readonly networkName: string;
  readonly handle?: string;
}

/**
 * Serialize refresh-token rotation across CLI processes sharing a profile.
 *
 * Refresh tokens are single-use. The critical section intentionally covers the
 * auth-server call as well as the local write, but it does not hold a SQLite
 * transaction open while waiting on the network.
 */
export async function withCredentialRefreshLock<T>(
  config: CLIConfig,
  key: CredentialRefreshLockKey,
  fn: () => Promise<T>,
): Promise<T> {
  const lockDir = lockDirFor(config, key);
  await fs.mkdir(path.dirname(lockDir), { recursive: true });

  const deadline = Date.now() + LOCK_WAIT_MS;
  let attempt = 0;

  for (;;) {
    try {
      await fs.mkdir(lockDir, { mode: 0o700 });
      try {
        await writeLockMetadata(lockDir, config, key);
        return await fn();
      } finally {
        await fs.rm(lockDir, { recursive: true, force: true });
      }
    } catch (err) {
      if (!isAlreadyExists(err)) {
        throw err;
      }

      if (await removeIfStale(lockDir)) {
        continue;
      }

      if (Date.now() >= deadline) {
        throw new RobotNetCLIError(
          `Timed out waiting for credential refresh lock for ${describeLockKey(key)}. ` +
            "Another robotnet process may be stuck refreshing credentials.",
        );
      }

      await sleep(nextDelayMs(attempt++));
    }
  }
}

function lockDirFor(config: CLIConfig, key: CredentialRefreshLockKey): string {
  const digest = crypto
    .createHash("sha256")
    .update(
      [
        config.profile,
        key.kind,
        key.networkName,
        key.handle ?? "",
      ].join("\0"),
    )
    .digest("hex");
  return path.join(config.paths.runDir, "credential-refresh-locks", `${digest}.lock`);
}

async function writeLockMetadata(
  lockDir: string,
  config: CLIConfig,
  key: CredentialRefreshLockKey,
): Promise<void> {
  const payload = {
    pid: process.pid,
    profile: config.profile,
    kind: key.kind,
    network: key.networkName,
    handle: key.handle ?? null,
    created_at: Date.now(),
  };
  await fs.writeFile(
    path.join(lockDir, "owner.json"),
    JSON.stringify(payload, null, 2) + "\n",
    "utf8",
  );
}

async function removeIfStale(lockDir: string): Promise<boolean> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(lockDir);
  } catch (err) {
    if (isNotFound(err)) return true;
    throw err;
  }

  if (Date.now() - stat.mtimeMs < STALE_LOCK_MS) {
    return false;
  }

  await fs.rm(lockDir, { recursive: true, force: true });
  return true;
}

function nextDelayMs(attempt: number): number {
  return Math.min(MAX_RETRY_MS, BASE_RETRY_MS * Math.max(1, attempt + 1));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeLockKey(key: CredentialRefreshLockKey): string {
  if (key.kind === "agent") {
    return `${key.handle ?? "(unknown agent)"} on network "${key.networkName}"`;
  }
  return `user session on network "${key.networkName}"`;
}

function isAlreadyExists(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "EEXIST"
  );
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}
