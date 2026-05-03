import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { tailLog } from "../src/network/logs.js";

function tmpLogFile(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "robotnet-logs-"));
  const file = path.join(dir, "operator.log");
  fs.writeFileSync(file, content);
  return file;
}

describe("tailLog", () => {
  it("returns the last N lines without --follow", async () => {
    const file = tmpLogFile("alpha\nbravo\ncharlie\ndelta\necho\n");
    const captured: string[] = [];
    await tailLog(file, {
      follow: false,
      lines: 2,
      out: (chunk) => captured.push(chunk),
    });
    assert.equal(captured.join(""), "delta\necho\n");
  });

  it("returns the entire file when fewer lines exist than requested", async () => {
    const file = tmpLogFile("only-line\n");
    const captured: string[] = [];
    await tailLog(file, {
      follow: false,
      lines: 50,
      out: (chunk) => captured.push(chunk),
    });
    assert.equal(captured.join(""), "only-line\n");
  });

  it("throws when the log file does not exist", async () => {
    await assert.rejects(
      tailLog("/tmp/robotnet-tests-definitely-not-a-file.log", {
        follow: false,
        out: () => undefined,
      }),
      /does not exist/,
    );
  });

  it("--follow streams appended content until aborted", async () => {
    const file = tmpLogFile("seed\n");
    const captured: string[] = [];
    const ctrl = new AbortController();

    const done = tailLog(file, {
      follow: true,
      lines: 50,
      out: (chunk) => captured.push(chunk),
      signal: ctrl.signal,
    });

    // Wait for the initial read to flush, then append.
    await new Promise((r) => setTimeout(r, 30));
    fs.appendFileSync(file, "appended-1\n");
    fs.appendFileSync(file, "appended-2\n");
    // Give the watcher a moment to fire.
    await new Promise((r) => setTimeout(r, 80));
    ctrl.abort();
    await done;

    const all = captured.join("");
    assert.match(all, /^seed\n/);
    assert.match(all, /appended-1\n/);
    assert.match(all, /appended-2\n/);
  });
});
