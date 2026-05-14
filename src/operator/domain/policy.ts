import type { OperatorRepository } from "../storage/repository.js";
import type { Handle } from "../storage/types.js";

/**
 * Trust enforcement.
 *
 * `isReachable(sender, target)` answers "does `target`'s inbound policy
 * admit `sender`?". Semantics per Whitepaper §6.2:
 *
 * - target's `inbound_policy = 'open'`: anyone is admitted.
 * - target's `inbound_policy = 'allowlist'`: admitted only when the
 *   sender's exact handle, or the owner glob `@owner.*` covering it,
 *   appears on target's allowlist.
 *
 * `canInitiate(initiator, peer)` runs the check in both directions. The
 * allowlist is symmetric: both gates must pass — the initiator must be
 * admitted by the peer's policy *and* the peer must be admitted by the
 * initiator's policy. For mixed pairs (allowlist + open), the
 * allowlist agent's gate dominates ("open" means *I have no gate*, not
 * *I am universally reachable*).
 *
 * Privacy property (Whitepaper §6.2): when an invite request contains
 * any unreachable invitee, the request fails as a whole and the caller
 * is told nothing about which one denied. The route layer therefore
 * folds `canInitiate` over the whole list and fails closed if any
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

export function canInitiate(
  repo: OperatorRepository,
  initiator: Handle,
  peer: Handle,
): boolean {
  // Self-trust: an agent may always address itself. Allowlist semantics
  // are about cross-agent trust and don't apply to self; mirrors email
  // convention (you can To/Cc yourself). Still requires the agent to
  // exist on this operator.
  if (initiator === peer) {
    return repo.agents.byHandle(initiator) !== null;
  }
  return isReachable(repo, initiator, peer) && isReachable(repo, peer, initiator);
}

/** `@owner.name` → `@owner.*`. Returns null when `handle` is malformed. */
function ownerGlobFor(handle: Handle): string | null {
  // Strip the leading `@`, split once on `.`, glob the second half.
  if (!handle.startsWith("@")) return null;
  const dot = handle.indexOf(".");
  if (dot === -1) return null;
  return `${handle.slice(0, dot)}.*`;
}
