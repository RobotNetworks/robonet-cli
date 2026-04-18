import { Option } from "commander";
import * as readline from "node:readline";

import { APIClient } from "../api/client.js";
import { DEFAULT_SCOPES } from "../auth/client-credentials.js";
import {
  resolveApiBearerToken,
  resolveMcpBearerToken,
  resolveRuntimeSession,
} from "../auth/runtime.js";
import { loadToken } from "../auth/token-store.js";
import type { CLIConfig } from "../config.js";
import { RoboNetCLIError } from "../errors.js";
import { MCPClient } from "../mcp-client.js";

// ── Input parsing ────────────────────────────────────────────────────

export function parsePositiveInt(value: string, fallback: number): number {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const THREAD_STATUSES = ["active", "closed", "archived"] as const;

export function parseThreadStatus(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (THREAD_STATUSES.includes(value as (typeof THREAD_STATUSES)[number])) {
    return value;
  }
  throw new RoboNetCLIError(
    `Invalid thread status: ${value}. Expected one of: ${THREAD_STATUSES.join(", ")}.`,
  );
}

// ── Option factories ─────────────────────────────────────────────────

export function clientIdOption(): Option {
  return new Option("--client-id <id>", "RoboNet client ID");
}
export function clientSecretOption(): Option {
  return new Option("--client-secret <secret>", "RoboNet client secret");
}
export function scopeOption(): Option {
  return new Option("--scope <scope>", "OAuth scopes").default(DEFAULT_SCOPES);
}
export function jsonOption(): Option {
  return new Option("--json", "Output as JSON").default(false);
}

// ── Display helpers ──────────────────────────────────────────────────

export function profileTitle(title: string, config: CLIConfig): string {
  return `${title} [profile=${config.profile}]`;
}

export function skillName(entry: unknown): string | undefined {
  if (typeof entry === "object" && entry !== null) {
    const name = (entry as Record<string, unknown>).name;
    return typeof name === "string" ? name : undefined;
  }
  return undefined;
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
  return promptText("RoboNet client ID", defaultValue);
}

export async function resolveClientSecret(
  provided: string | undefined,
): Promise<string> {
  if (provided) return provided;
  return promptSecret("RoboNet client secret");
}

export async function resolveCredentials(
  config: CLIConfig,
  opts: { clientId?: string; clientSecret?: string },
): Promise<{ clientId: string | null; clientSecret: string | null }> {
  const stored = loadToken(config.tokenStoreFile);
  const defaultClientId = stored?.clientId;

  if (!stored) {
    const clientId = await resolveClientId(opts.clientId, defaultClientId);
    const clientSecret = await resolveClientSecret(opts.clientSecret);
    return { clientId, clientSecret };
  }

  return {
    clientId: opts.clientId ?? defaultClientId ?? null,
    clientSecret: opts.clientSecret ?? null,
  };
}

// ── Authenticated client builders ────────────────────────────────────

export function buildAuthenticatedApiClient(config: CLIConfig): Promise<APIClient> {
  return resolveApiBearerToken({
    endpoints: config.endpoints,
    tokenStorePath: config.tokenStoreFile,
    clientId: null,
    clientSecret: null,
    scope: DEFAULT_SCOPES,
  }).then(
    (token) =>
      new APIClient(config.endpoints.apiBaseUrl, token.accessToken),
  );
}

export async function buildAuthenticatedMcpClient(
  config: CLIConfig,
): Promise<MCPClient> {
  const token = await resolveMcpBearerToken({
    endpoints: config.endpoints,
    tokenStorePath: config.tokenStoreFile,
    clientId: null,
    clientSecret: null,
    scope: DEFAULT_SCOPES,
  });
  return new MCPClient(config.endpoints.mcpBaseUrl, token.accessToken);
}
