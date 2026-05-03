import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  IdentityFileError,
  clearDirectoryIdentity,
  directoryIdentityPath,
  findDirectoryIdentity,
  resolveAgentIdentity,
  writeDirectoryIdentity,
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

describe("writeDirectoryIdentity", () => {
  it("creates .robotnet/asp.json with the asp-compatible shape", async () => {
    const filePath = await writeDirectoryIdentity(tmpDir, {
      handle: "@cli.bot",
      network: "local",
    });

    assert.equal(filePath, directoryIdentityPath(tmpDir));
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    assert.deepEqual(parsed, { version: 1, handle: "@cli.bot", network: "local" });
  });

  it("rejects an invalid handle without writing the file", async () => {
    await assert.rejects(
      writeDirectoryIdentity(tmpDir, { handle: "BAD", network: "local" }),
      InvalidHandleError,
    );
    assert.equal(fs.existsSync(directoryIdentityPath(tmpDir)), false);
  });
});

describe("findDirectoryIdentity", () => {
  it("returns undefined when no file exists anywhere up the tree", async () => {
    // Use a tmpdir-rooted scan to avoid picking up the workspace's .robotnet/asp.json.
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "robotnet-iso-"));
    try {
      const out = await findDirectoryIdentity(isolated);
      assert.equal(out, undefined);
    } finally {
      fs.rmSync(isolated, { recursive: true, force: true });
    }
  });

  it("walks up to find the identity from a nested subdirectory", async () => {
    await writeDirectoryIdentity(tmpDir, { handle: "@cli.bot", network: "local" });
    const nested = path.join(tmpDir, "a", "b", "c");
    fs.mkdirSync(nested, { recursive: true });

    const found = await findDirectoryIdentity(nested);
    assert.ok(found);
    assert.equal(found!.handle, "@cli.bot");
    assert.equal(found!.network, "local");
    assert.equal(found!.filePath, directoryIdentityPath(tmpDir));
  });

  it("throws IdentityFileError on a malformed JSON file", async () => {
    const dotDir = path.join(tmpDir, ".robotnet");
    fs.mkdirSync(dotDir);
    fs.writeFileSync(path.join(dotDir, "asp.json"), "{not json");

    await assert.rejects(
      findDirectoryIdentity(tmpDir),
      (err: unknown) =>
        err instanceof IdentityFileError && err.message.includes("not valid JSON"),
    );
  });

  it("throws IdentityFileError when required fields are missing", async () => {
    const dotDir = path.join(tmpDir, ".robotnet");
    fs.mkdirSync(dotDir);
    fs.writeFileSync(
      path.join(dotDir, "asp.json"),
      JSON.stringify({ version: 1, handle: "@cli.bot" }),
    );

    await assert.rejects(
      findDirectoryIdentity(tmpDir),
      (err: unknown) =>
        err instanceof IdentityFileError && err.message.includes("missing required"),
    );
  });
});

describe("clearDirectoryIdentity", () => {
  it("removes the file and reports true", async () => {
    await writeDirectoryIdentity(tmpDir, { handle: "@cli.bot", network: "local" });
    assert.equal(await clearDirectoryIdentity(tmpDir), true);
    assert.equal(fs.existsSync(directoryIdentityPath(tmpDir)), false);
  });

  it("reports false when no file existed", async () => {
    assert.equal(await clearDirectoryIdentity(tmpDir), false);
  });
});

describe("resolveAgentIdentity precedence", () => {
  it("--as flag wins over env and directory file", async () => {
    process.env.ROBOTNET_AGENT = "@from-env.bot";
    await writeDirectoryIdentity(tmpDir, {
      handle: "@from-dir.bot",
      network: "local",
    });

    const r = await resolveAgentIdentity({
      explicitHandle: "@from-flag.bot",
      resolvedNetwork: "robotnet",
      fromDir: tmpDir,
    });
    assert.ok(r);
    assert.equal(r!.handle, "@from-flag.bot");
    assert.equal(r!.network, "robotnet");
    assert.equal(r!.source, "flag");
  });

  it("ROBOTNET_AGENT env wins over directory file but inherits the directory's network", async () => {
    process.env.ROBOTNET_AGENT = "@from-env.bot";
    await writeDirectoryIdentity(tmpDir, {
      handle: "@from-dir.bot",
      network: "local",
    });

    const r = await resolveAgentIdentity({
      resolvedNetwork: "robotnet",
      fromDir: tmpDir,
    });
    assert.ok(r);
    assert.equal(r!.handle, "@from-env.bot");
    // The directory binding still gets to pick the network — workspaces typically
    // pin both together, and the env var only overrides "who am I".
    assert.equal(r!.network, "local");
    assert.equal(r!.source, "env");
  });

  it("directory file is used when nothing else is set", async () => {
    await writeDirectoryIdentity(tmpDir, {
      handle: "@cli.bot",
      network: "local",
    });

    const r = await resolveAgentIdentity({
      resolvedNetwork: "robotnet",
      fromDir: tmpDir,
    });
    assert.ok(r);
    assert.equal(r!.handle, "@cli.bot");
    assert.equal(r!.network, "local");
    assert.equal(r!.source, "directory");
  });

  it("returns undefined when nothing supplies a handle", async () => {
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "robotnet-iso-"));
    try {
      const r = await resolveAgentIdentity({
        resolvedNetwork: "robotnet",
        fromDir: isolated,
      });
      assert.equal(r, undefined);
    } finally {
      fs.rmSync(isolated, { recursive: true, force: true });
    }
  });

  it("validates the handle when it comes from --as", async () => {
    await assert.rejects(
      resolveAgentIdentity({
        explicitHandle: "BAD",
        resolvedNetwork: "robotnet",
        fromDir: tmpDir,
      }),
      InvalidHandleError,
    );
  });

  it("validates the handle when it comes from ROBOTNET_AGENT env", async () => {
    process.env.ROBOTNET_AGENT = "BAD";
    await assert.rejects(
      resolveAgentIdentity({
        resolvedNetwork: "robotnet",
        fromDir: tmpDir,
      }),
      InvalidHandleError,
    );
  });
});
