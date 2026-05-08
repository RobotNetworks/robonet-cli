#!/usr/bin/env -S node --import tsx
/**
 * Run the ASP conformance suite against the in-tree local operator.
 *
 * Driven by `npm run conformance`. Returns exit 0 on a clean conformance
 * run, exit 1 on any assertion failure, and exit 2 when prerequisites
 * (uv on PATH, asp repo at ASP_REPO_PATH) are missing.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { sha256Hex } from "../../src/operator/tokens.js";
import type { OperatorConfig } from "../../src/operator/config.js";
import { startOperatorServer, type OperatorHandle } from "../../src/operator/server.js";
import { openOperatorDatabase } from "../../src/operator/storage/database.js";
import { OperatorRepository } from "../../src/operator/storage/repository.js";

interface SeedAgent {
  readonly handle: string;
  readonly policy: "open" | "allowlist";
}

const REQUIRED_AGENTS: readonly SeedAgent[] = [
  { handle: "@alice.test", policy: "open" },
  { handle: "@bob.test", policy: "open" },
  { handle: "@carol.test", policy: "open" },
  // `@closed.test` exists for the policy-denial test. README says missing-agent
  // and policy-denial both 404 by design (Whitepaper §6.2 non-enumeration), so
  // running with this seeded gives the strict denial path.
  { handle: "@closed.test", policy: "allowlist" },
];

async function pickPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr === null || typeof addr === "string") {
        reject(new Error("could not get assigned port"));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

function fail(message: string, code = 1): never {
  process.stderr.write(`conformance: ${message}\n`);
  process.exit(code);
}

function which(cmd: string): string | null {
  const result = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], {
    encoding: "utf-8",
  });
  if (result.status !== 0) return null;
  return result.stdout.trim().split("\n")[0] ?? null;
}

function resolveAspRepoPath(): string {
  const env = process.env.ASP_REPO_PATH;
  if (env !== undefined && env.length > 0) return env;
  const here = path.dirname(fileURLToPath(import.meta.url));
  // robotnet-cli/tests/conformance/run-conformance.ts → up to robotnet-cli root,
  // then `../asp` for the workspace sibling layout.
  return path.resolve(here, "..", "..", "..", "asp");
}

interface SeededOperator {
  readonly handle: OperatorHandle;
  readonly db: ReturnType<typeof openOperatorDatabase>;
  readonly tokens: ReadonlyMap<string, string>;
  readonly cleanup: () => Promise<void>;
}

async function seedOperator(): Promise<SeededOperator> {
  const dir = mkdtempSync(path.join(tmpdir(), "robotnet-conformance-"));
  const dbPath = path.join(dir, "operator.sqlite");
  const port = await pickPort();
  const adminToken = sha256Hex(`conformance-${Date.now()}-${Math.random()}`);
  const config: OperatorConfig = {
    networkName: "conformance",
    host: "127.0.0.1",
    port,
    databasePath: dbPath,
    filesDir: path.join(path.dirname(dbPath), "files"),
    adminTokenHash: sha256Hex(adminToken),
    operatorVersion: "0.0.0-conformance",
  };
  const db = openOperatorDatabase(dbPath);
  const repo = new OperatorRepository(db);
  const handle = await startOperatorServer({ config, db, repo });
  process.stderr.write(
    `conformance: operator listening at http://${handle.host}:${handle.port}\n`,
  );

  const baseUrl = `http://${handle.host}:${handle.port}`;
  const tokens = new Map<string, string>();
  for (const seed of REQUIRED_AGENTS) {
    const res = await fetch(`${baseUrl}/_admin/agents`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ handle: seed.handle, policy: seed.policy }),
    });
    if (res.status !== 201) {
      throw new Error(
        `failed to seed ${seed.handle}: ${res.status} ${await res.text()}`,
      );
    }
    const created = (await res.json()) as { token: string };
    tokens.set(seed.handle, created.token);
  }

  return {
    handle,
    db,
    tokens,
    cleanup: async () => {
      await handle.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function runPytest(args: {
  readonly conformanceDir: string;
  readonly operator: SeededOperator;
  readonly uvBin: string;
}): Promise<number> {
  const tokensPayload: Record<string, string> = {};
  for (const [handle, token] of args.operator.tokens) {
    tokensPayload[handle] = token;
  }
  const baseUrl = `http://${args.operator.handle.host}:${args.operator.handle.port}`;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ASP_OPERATOR_URL: baseUrl,
    ASP_TEST_AGENTS: JSON.stringify(tokensPayload),
  };

  return await new Promise<number>((resolve, reject) => {
    const child = spawn(args.uvBin, ["run", "pytest", "--color=yes", "."], {
      cwd: args.conformanceDir,
      env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

async function main(): Promise<void> {
  const uvBin = which("uv");
  if (uvBin === null) {
    fail(
      "`uv` is not on PATH. Install with `brew install uv` (https://docs.astral.sh/uv/).",
      2,
    );
  }

  const aspRepo = resolveAspRepoPath();
  const conformanceDir = path.join(aspRepo, "tests", "conformance");
  if (!existsSync(conformanceDir)) {
    fail(
      `asp conformance suite not found at ${conformanceDir}. ` +
        `Set ASP_REPO_PATH if asp is checked out elsewhere.`,
      2,
    );
  }
  const operator = await seedOperator();
  let exitCode = 1;
  try {
    exitCode = await runPytest({ conformanceDir, operator, uvBin });
  } finally {
    await operator.cleanup();
  }

  process.exit(exitCode);
}

void main().catch((err: unknown) => {
  const detail = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`conformance: harness crashed: ${detail}\n`);
  process.exit(1);
});
