import { Command } from "commander";

import { resolveAgentIdentity, type AgentIdentitySource } from "../asmtp/identity.js";
import type { CLIConfig, NetworkAuthMode, NetworkConfig } from "../config.js";
import { openProcessCredentialStore } from "../credentials/lifecycle.js";
import { jsonOption, loadConfigFromRoot, out } from "./shared.js";

/**
 * Per-network probe budget. Status is meant to be cheap enough to invoke
 * from a session-start hook, so we cap each network probe well below the
 * 10-second discovery timeout used elsewhere — a dead remote network
 * shouldn't keep the user waiting at startup.
 */
const PROBE_TIMEOUT_MS = 3_000;

export interface NetworkStatus {
  readonly name: string;
  readonly url: string;
  readonly authMode: NetworkAuthMode;
  /** True iff the network's URL responded to a `GET` within {@link PROBE_TIMEOUT_MS}. */
  readonly reachable: boolean;
  /**
   * Identity that would be used by default for an agent command targeting
   * this network (the resolution chain: `--as` flag → `ROBOTNET_AGENT` env
   * → workspace `.robotnet/config.json`). `null` when no default would
   * resolve — note that this is independent of {@link storedHandles}; an
   * identity can be logged in (stored) without being the active default.
   */
  readonly identity: { readonly handle: string; readonly source: AgentIdentitySource } | null;
  /**
   * Handles with stored credentials for this network, in sorted order.
   * Populated from the encrypted credential store; addressable via
   * `--as <handle>` even when {@link identity} is `null`. Empty when the
   * store is empty for this network or inaccessible (a broken keychain
   * is degraded to `[]` so `status` stays safe to run from a startup hook).
   */
  readonly storedHandles: readonly string[];
}

/**
 * Probe contract used internally and by tests so the network call can be
 * stubbed without touching `globalThis.fetch`.
 */
export type ReachabilityProbe = (url: string) => Promise<boolean>;

/**
 * Stored-handle enumerator contract. Tests inject a fixed table; production
 * opens the encrypted credential store and lists per network.
 */
export type StoredHandlesProbe = (networkName: string) => Promise<readonly string[]>;

/**
 * `robotnet status` — for every configured network, report reachability and
 * the identity that would resolve when an agent command targets it.
 *
 * Designed to be safe to invoke from a session-start hook: probes run in
 * parallel with a tight per-network timeout, and human output is one line
 * per *live* network so an idle terminal session emits nothing.
 *
 * The human format intentionally carries a `[robotnet]` prefix so a hook
 * can pipe the output straight into a model harness's startup context
 * without any extra formatting. Use `--json` for programmatic consumers.
 */
export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description(
      "Per-network status: reachability, the active identity, and any other stored credentials for each known network",
    )
    .addOption(jsonOption())
    .action(async (opts: { json: boolean }, cmd: Command) => {
      const config = await loadConfigFromRoot(cmd);
      const statuses = await collectNetworkStatuses(config);
      if (opts.json) {
        out(formatStatusesJson(statuses));
      } else {
        for (const line of formatStatusesHuman(statuses)) out(line);
      }
    });
}

/**
 * Build the per-network status array for `config`, sorted by network name
 * for stable output. Reachability, identity resolution, and stored-handle
 * enumeration run in parallel across all configured networks.
 *
 * Both `probe` and `listStoredHandles` are parameterized to keep tests off
 * the wire / off the encrypted credential store. Production callers omit
 * them and get the default HTTP-GET probe + credential-store enumerator.
 */
export async function collectNetworkStatuses(
  config: CLIConfig,
  probe: ReachabilityProbe = defaultProbe,
  listStoredHandles?: StoredHandlesProbe,
): Promise<readonly NetworkStatus[]> {
  const resolveStored = listStoredHandles ?? (await defaultStoredHandlesProbe(config));
  const networks = Object.values(config.networks);
  const statuses = await Promise.all(
    networks.map((n) => buildNetworkStatus(n, probe, resolveStored)),
  );
  return [...statuses].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * One human line per *live* network. Dead networks are intentionally
 * omitted: the hook's job is to tell a model what's available, not what's
 * configured-but-down. Returns an empty array when nothing is live.
 *
 * Identity reporting distinguishes three cases:
 *   - active identity (resolution chain found one) — print the handle alone
 *   - no active identity but credentials stored — print `(stored: …)` so
 *     the user knows the network is logged in even though the workspace
 *     hasn't pinned a default agent (the most common confusion that the
 *     old "no identity" message produced)
 *   - no active identity and no stored credentials — print "no identity"
 */
export function formatStatusesHuman(
  statuses: readonly NetworkStatus[],
): readonly string[] {
  const lines: string[] = [];
  for (const s of statuses) {
    if (!s.reachable) continue;
    if (s.identity !== null) {
      lines.push(`[robotnet] ${s.name}: ${s.identity.handle}`);
    } else if (s.storedHandles.length > 0) {
      lines.push(
        `[robotnet] ${s.name}: reachable, no active identity (stored: ${s.storedHandles.join(", ")})`,
      );
    } else {
      lines.push(`[robotnet] ${s.name}: reachable, no identity`);
    }
  }
  return lines;
}

/** Stable JSON envelope for the status array, ready to write to stdout. */
export function formatStatusesJson(
  statuses: readonly NetworkStatus[],
): string {
  return JSON.stringify(
    { networks: statuses.map(toJsonShape) },
    null,
    2,
  );
}

async function buildNetworkStatus(
  network: NetworkConfig,
  probe: ReachabilityProbe,
  listStoredHandles: StoredHandlesProbe,
): Promise<NetworkStatus> {
  const [reachable, identity, storedHandles] = await Promise.all([
    probe(network.url),
    resolveAgentIdentity({
      explicitHandle: undefined,
      resolvedNetwork: network.name,
    }),
    listStoredHandles(network.name),
  ]);
  return {
    name: network.name,
    url: network.url,
    authMode: network.authMode,
    reachable,
    identity:
      identity !== undefined
        ? { handle: identity.handle, source: identity.source }
        : null,
    storedHandles: [...storedHandles].sort(),
  };
}

/**
 * Open the encrypted credential store once and return a per-network
 * enumerator that lists the handles registered against it. Degrades to
 * `() => []` if the store can't be opened (rotated keychain key, missing
 * file, permission error) so a partially-broken environment doesn't
 * crash `status` and break the session-start hook.
 */
async function defaultStoredHandlesProbe(
  config: CLIConfig,
): Promise<StoredHandlesProbe> {
  try {
    const store = await openProcessCredentialStore(config);
    return async (networkName) =>
      store.listAgentCredentials(networkName).map((c) => c.handle);
  } catch {
    return async () => [];
  }
}

async function defaultProbe(url: string): Promise<boolean> {
  // Any HTTP response — even a 4xx or 5xx — indicates the server is up.
  // Only DNS failures, connection refusals, and timeouts count as "down."
  try {
    await fetch(url.replace(/\/+$/, ""), {
      method: "GET",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      redirect: "follow",
    });
    return true;
  } catch {
    return false;
  }
}

function toJsonShape(s: NetworkStatus): Record<string, unknown> {
  return {
    name: s.name,
    url: s.url,
    auth_mode: s.authMode,
    reachable: s.reachable,
    identity:
      s.identity !== null
        ? { handle: s.identity.handle, source: s.identity.source }
        : null,
    stored_handles: s.storedHandles,
  };
}
