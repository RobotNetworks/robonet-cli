import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  IdentityFileError,
  clearDirectoryIdentity,
  directoryIdentityPath,
  findDirectoryDefaultNetwork,
  findDirectoryIdentityFile,
  lookupDirectoryHandle,
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

function writeRawIdentityFile(dir: string, payload: unknown): string {
  const dotDir = path.join(dir, ".robotnet");
  fs.mkdirSync(dotDir, { recursive: true });
  const filePath = path.join(dotDir, "asp.json");
  fs.writeFileSync(
    filePath,
    typeof payload === "string" ? payload : JSON.stringify(payload),
    "utf8",
  );
  return filePath;
}

describe("writeDirectoryIdentityEntry", () => {
  it("creates .robotnet/asp.json with the on-disk shape and seeds default_network", async () => {
    const filePath = await writeDirectoryIdentityEntry(tmpDir, {
      handle: "@cli.bot",
      network: "local",
    });

    assert.equal(filePath, directoryIdentityPath(tmpDir));
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    assert.deepEqual(parsed, {
      version: 1,
      identities: { local: "@cli.bot" },
      default_network: "local",
    });
  });

  it("preserves other networks' entries when adding a second one and does NOT overwrite default_network", async () => {
    await writeDirectoryIdentityEntry(tmpDir, {
      handle: "@me.dev",
      network: "local",
    });
    await writeDirectoryIdentityEntry(tmpDir, {
      handle: "@me.prod",
      network: "public",
    });

    const parsed = JSON.parse(
      fs.readFileSync(directoryIdentityPath(tmpDir), "utf8"),
    );
    assert.deepEqual(parsed, {
      version: 1,
      identities: { local: "@me.dev", public: "@me.prod" },
      default_network: "local",
    });
  });

  it("overwrites the same network's existing entry", async () => {
    await writeDirectoryIdentityEntry(tmpDir, {
      handle: "@old.bot",
      network: "local",
    });
    await writeDirectoryIdentityEntry(tmpDir, {
      handle: "@new.bot",
      network: "local",
    });

    const file = await findDirectoryIdentityFile(tmpDir);
    assert.ok(file);
    assert.deepEqual(file!.identities, { local: "@new.bot" });
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
    assert.deepEqual(found!.identities, { local: "@cli.bot" });
    assert.equal(found!.defaultNetwork, "local");
  });

  it("throws IdentityFileError on malformed JSON", async () => {
    writeRawIdentityFile(tmpDir, "{not json");
    await assert.rejects(
      findDirectoryIdentityFile(tmpDir),
      (err: unknown) =>
        err instanceof IdentityFileError && err.message.includes("not valid JSON"),
    );
  });

  it("throws IdentityFileError when version is unsupported", async () => {
    writeRawIdentityFile(tmpDir, { version: 99, identities: {} });
    await assert.rejects(
      findDirectoryIdentityFile(tmpDir),
      (err: unknown) =>
        err instanceof IdentityFileError && err.message.includes("unsupported"),
    );
  });

  it("throws IdentityFileError when identities is missing or wrong shape", async () => {
    writeRawIdentityFile(tmpDir, { version: 1, default_network: "local" });
    await assert.rejects(
      findDirectoryIdentityFile(tmpDir),
      (err: unknown) =>
        err instanceof IdentityFileError && err.message.includes("identities"),
    );
  });

  it("throws IdentityFileError when an identity entry isn't a string handle", async () => {
    writeRawIdentityFile(tmpDir, { version: 1, identities: { local: 42 } });
    await assert.rejects(
      findDirectoryIdentityFile(tmpDir),
      (err: unknown) =>
        err instanceof IdentityFileError &&
        err.message.includes('entry for network "local"'),
    );
  });

  it("accepts a file with no default_network", async () => {
    writeRawIdentityFile(tmpDir, {
      version: 1,
      identities: { local: "@me.dev" },
    });
    const found = await findDirectoryIdentityFile(tmpDir);
    assert.ok(found);
    assert.equal(found!.defaultNetwork, undefined);
    assert.deepEqual(found!.identities, { local: "@me.dev" });
  });
});

describe("lookupDirectoryHandle", () => {
  it("returns the handle for a known network and undefined otherwise", async () => {
    await writeDirectoryIdentityEntry(tmpDir, {
      handle: "@me.dev",
      network: "local",
    });
    const file = await findDirectoryIdentityFile(tmpDir);
    assert.ok(file);
    assert.equal(lookupDirectoryHandle(file!, "local"), "@me.dev");
    assert.equal(lookupDirectoryHandle(file!, "public"), undefined);
  });
});

describe("findDirectoryDefaultNetwork", () => {
  it("returns the default_network when present", async () => {
    await writeDirectoryIdentityEntry(tmpDir, {
      handle: "@me.dev",
      network: "local",
    });
    assert.equal(await findDirectoryDefaultNetwork(tmpDir), "local");
  });

  it("returns undefined when no file is found", async () => {
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "robotnet-iso-"));
    try {
      assert.equal(await findDirectoryDefaultNetwork(isolated), undefined);
    } finally {
      fs.rmSync(isolated, { recursive: true, force: true });
    }
  });
});

describe("clearDirectoryIdentity", () => {
  it("removes the file and reports true", async () => {
    await writeDirectoryIdentityEntry(tmpDir, {
      handle: "@cli.bot",
      network: "local",
    });
    assert.equal(await clearDirectoryIdentity(tmpDir), true);
    assert.equal(fs.existsSync(directoryIdentityPath(tmpDir)), false);
  });

  it("reports false when no file existed", async () => {
    assert.equal(await clearDirectoryIdentity(tmpDir), false);
  });
});

describe("resolveAgentIdentity precedence (--as > env > directory[network])", () => {
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
    assert.equal(r!.network, "public");
    assert.equal(r!.source, "flag");
  });

  it("ROBOTNET_AGENT env wins over directory file and binds to the resolved network (not the directory's)", async () => {
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
    assert.equal(r!.network, "public");
    assert.equal(r!.source, "env");
  });

  it("directory file is used only when its identities map has an entry for the resolved network", async () => {
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

    const unmatched = await resolveAgentIdentity({
      resolvedNetwork: "public",
      fromDir: tmpDir,
    });
    assert.equal(unmatched, undefined);
  });

  it("returns undefined when nothing supplies a handle for the resolved network", async () => {
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
