import { Command } from "commander";

import { resolveAgentIdentity, type AgentIdentitySource } from "../asp/identity.js";
import type { CLIConfig, NetworkAuthMode, NetworkConfig } from "../config.js";
import { loadConfigFromRoot, out } from "./asp-shared.js";
import { jsonOption } from "./shared.js";

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
  /** Identity that would be used for an agent command targeting this network, or `null` if none would resolve. */
  readonly identity: { readonly handle: string; readonly source: AgentIdentitySource } | null;
}

/**
 * Probe contract used internally and by tests so the network call can be
 * stubbed without touching `globalThis.fetch`.
 */
export type ReachabilityProbe = (url: string) => Promise<boolean>;

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
      "Per-network status: reachability and the identity that would resolve for each known network",
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
 * for stable output. Reachability and identity resolution run in parallel
 * across all configured networks.
 *
 * `probe` is parameterized to keep tests off the wire; production callers
 * pass nothing and get the default HTTP-GET probe.
 */
export async function collectNetworkStatuses(
  config: CLIConfig,
  probe: ReachabilityProbe = defaultProbe,
): Promise<readonly NetworkStatus[]> {
  const networks = Object.values(config.networks);
  const statuses = await Promise.all(
    networks.map((n) => buildNetworkStatus(n, probe)),
  );
  return [...statuses].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * One human line per *live* network. Dead networks are intentionally
 * omitted: the hook's job is to tell a model what's available, not what's
 * configured-but-down. Returns an empty array when nothing is live.
 */
export function formatStatusesHuman(
  statuses: readonly NetworkStatus[],
): readonly string[] {
  const lines: string[] = [];
  for (const s of statuses) {
    if (!s.reachable) continue;
    if (s.identity !== null) {
      lines.push(`[robotnet] ${s.name}: ${s.identity.handle}`);
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
): Promise<NetworkStatus> {
  const [reachable, identity] = await Promise.all([
    probe(network.url),
    resolveAgentIdentity({
      explicitHandle: undefined,
      resolvedNetwork: network.name,
    }),
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
  };
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
  };
}
