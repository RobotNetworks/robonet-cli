import type { NetworkConfig } from "../config.js";

import { NotALocalNetworkError } from "./errors.js";

/**
 * Hostnames that resolve to the local machine. Used as the loopback gate for
 * `robotnet network <subcommand>`: only loopback-bound networks may be
 * supervised from the CLI. Names are compared case-insensitively.
 */
const LOOPBACK_HOSTNAMES: readonly string[] = ["127.0.0.1", "::1", "localhost"];

/**
 * Throw {@link NotALocalNetworkError} unless `network` is a local-supervisable
 * network: `agent-token` auth mode AND a loopback URL host.
 *
 * Why both conditions: `agent-token` alone would let a misconfigured remote
 * `agent-token` network get supervised; a loopback URL alone would let an
 * `oauth` (remote-by-design) network supervised locally.
 */
export function assertLocalNetwork(network: NetworkConfig): void {
  if (network.authMode !== "agent-token") {
    throw new NotALocalNetworkError(
      network.name,
      `auth_mode is "${network.authMode}", expected "agent-token"`,
    );
  }
  let host: string;
  try {
    // URL.hostname returns IPv6 addresses surrounded by square brackets in
    // some Node versions ("[::1]") and bare in others. Strip brackets so
    // the comparison works regardless.
    host = new URL(network.url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new NotALocalNetworkError(network.name, `url is not parseable: ${detail}`);
  }
  if (!LOOPBACK_HOSTNAMES.includes(host)) {
    throw new NotALocalNetworkError(
      network.name,
      `url host "${host}" is not loopback`,
    );
  }
}

/** Return the port the network expects to be reachable on. Falls back to 80/443 when omitted. */
export function networkPort(network: NetworkConfig): number {
  const u = new URL(network.url);
  if (u.port.length > 0) return Number.parseInt(u.port, 10);
  return u.protocol === "https:" ? 443 : 80;
}
