import { Option } from "commander";
import * as readline from "node:readline";

import type { CLIConfig } from "../config.js";

// ── Option factories ─────────────────────────────────────────────────

export function clientIdOption(): Option {
  return new Option("--client-id <id>", "Robot Networks client ID");
}
export function clientSecretOption(): Option {
  return new Option("--client-secret <secret>", "Robot Networks client secret");
}
export function scopeOption(): Option {
  // No `.default(...)`: the right scope set depends on whether the
  // command runs in user or agent mode. Leaving this undefined lets each
  // entrypoint (`performPkceLogin`, `performAgentPkceLogin`, etc.) fall
  // through to its own bucket-appropriate default.
  return new Option("--scope <scope>", "OAuth scopes");
}
export function jsonOption(): Option {
  return new Option("--json", "Output as JSON").default(false);
}

// ── Display helpers ──────────────────────────────────────────────────

export function profileTitle(title: string, config: CLIConfig): string {
  return `${title} [profile=${config.profile}]`;
}

// ── Prompt helpers ───────────────────────────────────────────────────

export function promptText(label: string, defaultValue?: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  const prompt = defaultValue ? `${label} [${defaultValue}]: ` : `${label}: `;
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      const trimmed = answer.trim();
      resolve(trimmed || defaultValue || "");
    });
  });
}

export function promptSecret(label: string): Promise<string> {
  return new Promise((resolve) => {
    process.stderr.write(`${label}: `);
    const stdin = process.stdin;
    const wasTTY = stdin.isTTY;
    if (wasTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf-8");

    let input = "";
    const onData = (ch: string) => {
      if (ch === "\n" || ch === "\r" || ch === "\u0004") {
        if (wasTTY) stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener("data", onData);
        process.stderr.write("\n");
        resolve(input.trim());
      } else if (ch === "\u0003") {
        if (wasTTY) stdin.setRawMode(false);
        process.exit(130);
      } else if (ch === "\u007f" || ch === "\b") {
        input = input.slice(0, -1);
      } else {
        input += ch;
      }
    };
    stdin.on("data", onData);
  });
}

// ── Credential resolution ────────────────────────────────────────────

export async function resolveClientId(
  provided: string | undefined,
  defaultValue?: string,
): Promise<string> {
  if (provided) return provided;
  return promptText("Robot Networks client ID", defaultValue);
}

export async function resolveClientSecret(
  provided: string | undefined,
): Promise<string> {
  if (provided) return provided;
  return promptSecret("Robot Networks client secret");
}
