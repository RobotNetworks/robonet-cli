import type { ParticipantStatus } from "../storage/types.js";

/**
 * Event-eligibility filtering — Whitepaper §6.4.
 *
 * For live delivery and history fetch, what an agent is allowed to see
 * depends on their *current* status in that session:
 *
 * - `joined`: every event in the session.
 * - `invited`: only `session.invited` and `session.ended` (so an
 *   uninvited agent can't probe a session's content).
 * - `left`: nothing past the moment they left. Live delivery never
 *   touches them; history walks the log status-by-status (handled by
 *   the service layer) so the eligibility check here is just "no".
 *
 * This module is deliberately data-only — no DB access, no IO — so it
 * stays trivially testable.
 */
export function isEligible(
  status: ParticipantStatus,
  eventType: string,
): boolean {
  switch (status) {
    case "joined":
      return true;
    case "invited":
      return eventType === "session.invited" || eventType === "session.ended";
    case "left":
      return false;
  }
}
