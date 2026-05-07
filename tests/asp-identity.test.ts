import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  IdentityFileError,
  clearDirectoryIdentity,
  directoryIdentityPath,
  findDirectoryIdentityFile,
  resolveAgentIdentity,
  writeDirectoryIdentityEntry,
} from "../src/asp/identity.js";
import { InvalidHandleError } from "../src/asp/handles.js";

let tmpDir: string;
let originalAgentEnv: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "robotnet-identity-test-"));
  originalAgentEnv = process.env.ROBOTNET_AGENT;
  delete process.env.ROBOTNET_AGENT;
});

afterEach(() => {
  if (originalAgentEnv === undefined) {
    delete process.env.ROBOTNET_AGENT;
  } else {
    process.env.ROBOTNET_AGENT = originalAgentEnv;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeRawWorkspaceFile(dir: string, payload: unknown): string {
  const dotDir = path.join(dir, ".robotnet");
  fs.mkdirSync(dotDir, { recursive: true });
  const filePath = path.join(dotDir, "config.json");
  fs.writeFileSync(
    filePath,
    typeof payload === "string" ? payload : JSON.stringify(payload),
    "utf8",
  );
  return filePath;
}

describe("writeDirectoryIdentityEntry", () => {
  it("creates .robotnet/config.json and seeds the workspace `network` pin", async () => {
    const filePath = await writeDirectoryIdentityEntry(tmpDir, {
      handle: "@cli.bot",
      network: "local",
    });

    assert.equal(filePath, directoryIdentityPath(tmpDir));
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    assert.deepEqual(parsed, {
      agent: "@cli.bot",
      network: "local",
    });
  });

  it("overwrites the existing `agent` field and does NOT overwrite an existing `network` pin", async () => {
    await writeDirectoryIdentityEntry(tmpDir, {
      handle: "@me.dev",
      network: "local",
    });
    await writeDirectoryIdentityEntry(tmpDir, {
      handle: "@new.bot",
      network: "public",
    });

    const parsed = JSON.parse(
      fs.readFileSync(directoryIdentityPath(tmpDir), "utf8"),
    );
    // agent updated; network pin from the first set is preserved
    assert.deepEqual(parsed, {
      agent: "@new.bot",
      network: "local",
    });
  });

  it("preserves unrelated keys (`profile`, custom fields) already present in the file", async () => {
    writeRawWorkspaceFile(tmpDir, {
      profile: "work",
      network: "public",
      custom: "value",
    });

    await writeDirectoryIdentityEntry(tmpDir, {
      handle: "@me.dev",
      network: "local",
    });

    const parsed = JSON.parse(
      fs.readFileSync(directoryIdentityPath(tmpDir), "utf8"),
    );
    assert.deepEqual(parsed, {
      profile: "work",
      network: "public",
      custom: "value",
      agent: "@me.dev",
    });
  });

  it("rejects an invalid handle without writing the file", async () => {
    await assert.rejects(
      writeDirectoryIdentityEntry(tmpDir, { handle: "BAD", network: "local" }),
      InvalidHandleError,
    );
    assert.equal(fs.existsSync(directoryIdentityPath(tmpDir)), false);
  });
});

describe("findDirectoryIdentityFile", () => {
  it("returns undefined when no file exists anywhere up the tree", async () => {
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "robotnet-iso-"));
    try {
      const out = await findDirectoryIdentityFile(isolated);
      assert.equal(out, undefined);
    } finally {
      fs.rmSync(isolated, { recursive: true, force: true });
    }
  });

  it("walks up to find the file from a nested subdirectory", async () => {
    await writeDirectoryIdentityEntry(tmpDir, {
      handle: "@cli.bot",
      network: "local",
    });
    const nested = path.join(tmpDir, "a", "b", "c");
    fs.mkdirSync(nested, { recursive: true });

    const found = await findDirectoryIdentityFile(nested);
    assert.ok(found);
    assert.equal(found!.filePath, directoryIdentityPath(tmpDir));
    assert.equal(found!.agent, "@cli.bot");
    assert.equal(found!.network, "local");
  });

  it("throws IdentityFileError on malformed JSON", async () => {
    writeRawWorkspaceFile(tmpDir, "{not json");
    await assert.rejects(
      findDirectoryIdentityFile(tmpDir),
      (err: unknown) =>
        err instanceof IdentityFileError && err.message.includes("not valid JSON"),
    );
  });

  it("returns undefined fields when the file has no `agent`/`network` (e.g. only `profile`)", async () => {
    writeRawWorkspaceFile(tmpDir, { profile: "work" });
    const found = await findDirectoryIdentityFile(tmpDir);
    assert.ok(found);
    assert.equal(found!.agent, undefined);
    assert.equal(found!.network, undefined);
  });

  it("throws IdentityFileError when `agent` is not a string", async () => {
    writeRawWorkspaceFile(tmpDir, { agent: 42 });
    await assert.rejects(
      findDirectoryIdentityFile(tmpDir),
      (err: unknown) =>
        err instanceof IdentityFileError && err.message.includes("`agent`"),
    );
  });
});

describe("clearDirectoryIdentity", () => {
  it("removes the file when only `agent` was set", async () => {
    writeRawWorkspaceFile(tmpDir, { agent: "@cli.bot" });
    assert.equal(await clearDirectoryIdentity(tmpDir), true);
    assert.equal(fs.existsSync(directoryIdentityPath(tmpDir)), false);
  });

  it("preserves `profile` and `network` keys when clearing the agent", async () => {
    writeRawWorkspaceFile(tmpDir, {
      profile: "work",
      network: "local",
      agent: "@cli.bot",
    });
    assert.equal(await clearDirectoryIdentity(tmpDir), true);
    const parsed = JSON.parse(
      fs.readFileSync(directoryIdentityPath(tmpDir), "utf8"),
    );
    assert.deepEqual(parsed, { profile: "work", network: "local" });
  });

  it("reports false when no file existed", async () => {
    assert.equal(await clearDirectoryIdentity(tmpDir), false);
  });

  it("reports false when the file exists but has no `agent` key", async () => {
    writeRawWorkspaceFile(tmpDir, { network: "local" });
    assert.equal(await clearDirectoryIdentity(tmpDir), false);
    const parsed = JSON.parse(
      fs.readFileSync(directoryIdentityPath(tmpDir), "utf8"),
    );
    assert.deepEqual(parsed, { network: "local" });
  });
});

describe("resolveAgentIdentity precedence (--as > env > directory[scoped])", () => {
  it("--as flag wins over env and directory file", async () => {
    process.env.ROBOTNET_AGENT = "@from-env.bot";
    await writeDirectoryIdentityEntry(tmpDir, {
      handle: "@from-dir.bot",
      network: "local",
    });

    const r = await resolveAgentIdentity({
      explicitHandle: "@from-flag.bot",
      resolvedNetwork: "public",
      fromDir: tmpDir,
    });
    assert.ok(r);
    assert.equal(r!.handle, "@from-flag.bot");
    assert.equal(r!.source, "flag");
  });

  it("ROBOTNET_AGENT env wins over directory file (and is not network-scoped — applies to whatever network resolved)", async () => {
    process.env.ROBOTNET_AGENT = "@from-env.bot";
    await writeDirectoryIdentityEntry(tmpDir, {
      handle: "@from-dir.bot",
      network: "local",
    });

    const r = await resolveAgentIdentity({
      resolvedNetwork: "public",
      fromDir: tmpDir,
    });
    assert.ok(r);
    assert.equal(r!.handle, "@from-env.bot");
    assert.equal(r!.source, "env");
  });

  it("directory file contributes ONLY when its `network` matches the resolved network", async () => {
    await writeDirectoryIdentityEntry(tmpDir, {
      handle: "@local.bot",
      network: "local",
    });

    const matched = await resolveAgentIdentity({
      resolvedNetwork: "local",
      fromDir: tmpDir,
    });
    assert.ok(matched);
    assert.equal(matched!.handle, "@local.bot");
    assert.equal(matched!.source, "directory");
    assert.equal(matched!.sourceFile, directoryIdentityPath(tmpDir));

    const unmatched = await resolveAgentIdentity({
      resolvedNetwork: "public",
      fromDir: tmpDir,
    });
    assert.equal(unmatched, undefined);
  });

  it("returns undefined when nothing supplies a handle", async () => {
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "robotnet-iso-"));
    try {
      const r = await resolveAgentIdentity({
        resolvedNetwork: "public",
        fromDir: isolated,
      });
      assert.equal(r, undefined);
    } finally {
      fs.rmSync(isolated, { recursive: true, force: true });
    }
  });

  it("returns undefined when the workspace file has an agent but no `network` field to scope it", async () => {
    writeRawWorkspaceFile(tmpDir, { agent: "@orphan.bot" });
    const r = await resolveAgentIdentity({
      resolvedNetwork: "local",
      fromDir: tmpDir,
    });
    assert.equal(r, undefined);
  });

  it("validates the handle when it comes from --as", async () => {
    await assert.rejects(
      resolveAgentIdentity({
        explicitHandle: "BAD",
        resolvedNetwork: "public",
        fromDir: tmpDir,
      }),
      InvalidHandleError,
    );
  });

  it("validates the handle when it comes from ROBOTNET_AGENT env", async () => {
    process.env.ROBOTNET_AGENT = "BAD";
    await assert.rejects(
      resolveAgentIdentity({
        resolvedNetwork: "public",
        fromDir: tmpDir,
      }),
      InvalidHandleError,
    );
  });
});
