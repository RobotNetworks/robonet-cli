// Cross-platform test runner.
//
// Unix shells expand `tests/*.test.ts` before spawning node; Windows shells
// (cmd.exe / PowerShell) don't, so the literal glob string was being passed
// through and node couldn't find a file named `tests/*.test.ts`. Doing the
// discovery in-process side-steps the shell entirely and works the same way
// across every supported Node version (20/22/24) on every supported OS.

import { readdirSync, existsSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const TESTS_DIR = path.join(ROOT, "tests");

if (!existsSync(TESTS_DIR) || !statSync(TESTS_DIR).isDirectory()) {
  console.error(`No tests directory at ${TESTS_DIR}`);
  process.exit(1);
}

const files = readdirSync(TESTS_DIR)
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => path.join("tests", name));

if (files.length === 0) {
  console.error(`No *.test.ts files found in ${TESTS_DIR}`);
  process.exit(1);
}

const args = ["--import", "tsx", "--test", ...files];
const child = spawn(process.execPath, args, {
  stdio: "inherit",
  cwd: ROOT,
  // `shell: false` (the default) avoids the same shell-glob trap on
  // Windows that the npm script just hit.
});
child.on("exit", (code, signal) => {
  if (signal !== null) {
    // Mirror the conventional shell exit code for signals.
    process.exit(128 + (typeof signal === "string" ? 1 : 0));
  }
  process.exit(code ?? 0);
});
