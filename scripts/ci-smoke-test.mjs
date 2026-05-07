#!/usr/bin/env node
/**
 * End-to-end smoke test: exercise the actual `robotnet` binary against the
 * local operator. Catches wiring regressions that unit tests miss — every
 * step here goes through commander, the credential store, the supervisor,
 * and a live HTTP roundtrip to the spawned operator.
 *
 * Runs against an isolated XDG_CONFIG_HOME / XDG_STATE_HOME so it never
 * touches the developer's real CLI config or credentials. Uses the local
 * operator only (no network access required).
 *
 * Invoke with `npm run smoke` after `npm run build`.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, "..", "bin", "robotnet.js");

/**
 * Bind a server on `127.0.0.1:0` to learn an ephemeral free port, then
 * release it. Racy by definition — a port we just released could be
 * grabbed before the operator binds it — but in practice good enough for
 * a smoke test run on CI runners (and avoids hard-coding 8723, which
 * collides with any developer who already has a real operator running
 * on the host).
 */
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr === null || typeof addr === "string") {
        srv.close();
        reject(new Error("could not pick free port"));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

const tmpHome = mkdtempSync(join(tmpdir(), "robotnet-smoke-"));
const port = await pickFreePort();

// Override the built-in `local` network's URL via a profile config so the
// smoke test can run on a host that already has a real operator on the
// default port 8723.
const configDir = join(tmpHome, "config", "robotnet");
mkdirSync(configDir, { recursive: true });
writeFileSync(
  join(configDir, "config.json"),
  JSON.stringify(
    {
      networks: {
        local: { url: `http://127.0.0.1:${port}`, auth_mode: "agent-token" },
      },
    },
    null,
    2,
  ),
);

const childEnv = {
  ...process.env,
  XDG_CONFIG_HOME: join(tmpHome, "config"),
  XDG_STATE_HOME: join(tmpHome, "state"),
};

/** Run the CLI with the given argv. Throws on non-zero exit. Returns stdout. */
function run(args) {
  process.stdout.write(`[smoke] $ robotnet ${args.join(" ")}\n`);
  const result = spawnSync(process.execPath, [CLI, ...args], {
    env: childEnv,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    process.stderr.write(`stdout:\n${result.stdout}\n`);
    process.stderr.write(`stderr:\n${result.stderr}\n`);
    throw new Error(`robotnet ${args.join(" ")} exited ${result.status}`);
  }
  return result.stdout;
}

let started = false;
let exitCode = 0;
try {
  run(["--network", "local", "network", "start"]);
  started = true;

  run(["--network", "local", "admin", "agent", "create", "@ci.bot"]);

  const listJson = run([
    "--network",
    "local",
    "admin",
    "agent",
    "list",
    "--json",
  ]);
  if (!listJson.includes("@ci.bot")) {
    throw new Error(`admin agent list missing @ci.bot:\n${listJson}`);
  }

  run(["--network", "local", "network", "status"]);

  process.stdout.write("[smoke] OK\n");
} catch (err) {
  process.stderr.write(`[smoke] FAILED: ${err.message}\n`);
  exitCode = 1;
} finally {
  if (started) {
    try {
      run(["--network", "local", "network", "stop"]);
    } catch (err) {
      process.stderr.write(`[smoke] cleanup: stop failed: ${err.message}\n`);
      if (exitCode === 0) exitCode = 1;
    }
  }
  process.exit(exitCode);
}
