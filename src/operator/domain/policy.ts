import type { OperatorRepository } from "../storage/repository.js";
import type { Handle } from "../storage/types.js";

/**
 * Trust enforcement.
 *
 * `isReachable(sender, target)` is the operator-side analog of "may
 * `sender` send a session to `target` right now?". The semantics mirror
 * the ASP whitepaper §6.2:
 *
 * - target's `inbound_policy = 'open'`: anyone can reach.
 * - target's `inbound_policy = 'allowlist'`: reachable only when the
 *   sender's exact handle, or the owner glob `@owner.*` covering it,
 *   appears on target's allowlist.
 *
 * Privacy property (Whitepaper §6.2): when an invite request contains
 * any unreachable invitee, the request fails as a whole and the caller
 * is told nothing about which one denied. The route layer therefore
 * folds `isReachable` over the whole list and fails closed if any
 * member returns false.
 */

export function isReachable(
  repo: OperatorRepository,
  sender: Handle,
  target: Handle,
): boolean {
  const targetAgent = repo.agents.byHandle(target);
  if (targetAgent === null) return false;
  if (targetAgent.inboundPolicy === "open") return true;
  const allowlist = repo.agents.listAllowlist(target).map((e) => e.entry);
  if (allowlist.includes(sender)) return true;
  const ownerGlob = ownerGlobFor(sender);
  return ownerGlob !== null && allowlist.includes(ownerGlob);
}

/** `@owner.name` → `@owner.*`. Returns null when `handle` is malformed. */
function ownerGlobFor(handle: Handle): string | null {
  // Strip the leading `@`, split once on `.`, glob the second half.
  if (!handle.startsWith("@")) return null;
  const dot = handle.indexOf(".");
  if (dot === -1) return null;
  return `${handle.slice(0, dot)}.*`;
}
