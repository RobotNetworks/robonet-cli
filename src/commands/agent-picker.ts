import * as readline from "node:readline";

import type { AccountAgent } from "../auth/account-agents.js";
import { RobotNetCLIError } from "../errors.js";

/**
 * Interactive agent picker for `robotnet login --agent` (no handle).
 *
 * Renders a numbered list to stderr, reads a numeric selection from stdin,
 * and returns the chosen handle. The prompt loops on invalid input. Empty
 * input or `q`/`Q` aborts with {@link RobotNetCLIError}.
 *
 * stdout stays clean for `--json` consumers: every byte we emit during the
 * picker goes to stderr.
 */
export async function pickAgent(
  agents: readonly AccountAgent[],
): Promise<string> {
  if (agents.length === 0) {
    throw new RobotNetCLIError(
      "Your account has no agents to log into. Create one on the website first.",
    );
  }
  if (agents.length === 1) {
    process.stderr.write(`Logging in as the only agent on your account: ${agents[0].handle}\n`);
    return agents[0].handle;
  }

  // Stable ordering: alphabetical by handle so the menu doesn't reshuffle
  // between invocations even if the API's order isn't deterministic.
  const sorted = [...agents].sort((a, b) => a.handle.localeCompare(b.handle));
  process.stderr.write("Pick an agent to log in as:\n");
  sorted.forEach((agent, i) => {
    const label = formatLabel(agent);
    process.stderr.write(`  [${i + 1}] ${label}\n`);
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    while (true) {
      const answer = await new Promise<string>((resolve) => {
        rl.question(`Enter a number 1-${sorted.length} (or q to cancel): `, resolve);
      });
      const trimmed = answer.trim();
      if (trimmed.length === 0 || trimmed === "q" || trimmed === "Q") {
        throw new RobotNetCLIError("Login cancelled.");
      }
      const n = Number.parseInt(trimmed, 10);
      if (!Number.isInteger(n) || String(n) !== trimmed || n < 1 || n > sorted.length) {
        process.stderr.write(`Not a valid choice. Pick a number between 1 and ${sorted.length}.\n`);
        continue;
      }
      return sorted[n - 1].handle;
    }
  } finally {
    rl.close();
  }
}

function formatLabel(agent: AccountAgent): string {
  // Pad the handle so any name/policy info aligns even with mixed lengths.
  const parts: string[] = [agent.handle];
  if (agent.name !== undefined) parts.push(`(${agent.name})`);
  if (agent.policy !== undefined) parts.push(`policy=${agent.policy}`);
  return parts.join("  ");
}
