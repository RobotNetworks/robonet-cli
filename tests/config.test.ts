import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { defaultPaths, findWorkspaceConfigFile, loadConfig } from "../src/config.js";
import { ConfigurationError } from "../src/errors.js";
import { isolatedXdg } from "./helpers.js";

let env: ReturnType<typeof isolatedXdg>;

beforeEach(() => {
  env = isolatedXdg();
});

afterEach(() => {
  env.cleanup();
});

describe("defaultPaths", () => {
  it("default profile uses root robonet dirs", () => {
    const paths = defaultPaths("default");

    assert.equal(paths.configDir, path.join(env.tmpDir, "config", "robonet"));
    assert.equal(paths.stateDir, path.join(env.tmpDir, "state", "robonet"));
  });

  it("named profile uses profiles subdirectories", () => {
    const paths = defaultPaths("work");

    assert.equal(
      paths.configDir,
      path.join(env.tmpDir, "config", "robonet", "profiles", "work"),
    );
    assert.equal(
      paths.stateDir,
      path.join(env.tmpDir, "state", "robonet", "profiles", "work"),
    );
  });
});

describe("loadConfig", () => {
  it("reads profile from argument", () => {
    const config = loadConfig("ops", { cwd: env.tmpDir });

    assert.equal(config.profile, "ops");
    assert.equal(config.profileSource.kind, "flag");
    assert.equal(
      config.tokenStoreFile,
      path.join(
        env.tmpDir,
        "config",
        "robonet",
        "profiles",
        "ops",
        "auth.json",
      ),
    );
  });

  it("honors endpoint env overrides", () => {
    process.env.ROBONET_API_BASE_URL = "https://api.example.test/v1";

    const config = loadConfig(undefined, { cwd: env.tmpDir });

    assert.equal(config.endpoints.apiBaseUrl, "https://api.example.test/v1");
  });

  it("falls back to default profile when nothing is set", () => {
    const config = loadConfig(undefined, { cwd: env.tmpDir });

    assert.equal(config.profile, "default");
    assert.equal(config.profileSource.kind, "default");
  });

  it("reads profile from ROBONET_PROFILE env var", () => {
    process.env.ROBONET_PROFILE = "work";

    const config = loadConfig(undefined, { cwd: env.tmpDir });

    assert.equal(config.profile, "work");
    assert.equal(config.profileSource.kind, "env");
  });
});

describe("workspace profile config", () => {
  function setupWorkspace(dir: string, profileName: string): string {
    const wsDir = path.join(dir, ".robonet");
    fs.mkdirSync(wsDir, { recursive: true });
    const file = path.join(wsDir, "config.json");
    fs.writeFileSync(file, JSON.stringify({ profile: profileName }));
    return file;
  }

  function setupProfileDir(profileName: string): void {
    fs.mkdirSync(defaultPaths(profileName).configDir, { recursive: true });
  }

  it("findWorkspaceConfigFile finds a file in cwd", () => {
    const file = setupWorkspace(env.tmpDir, "work");

    assert.equal(findWorkspaceConfigFile(env.tmpDir), file);
  });

  it("findWorkspaceConfigFile walks up to find a file in an ancestor", () => {
    const file = setupWorkspace(env.tmpDir, "work");
    const nested = path.join(env.tmpDir, "a", "b", "c");
    fs.mkdirSync(nested, { recursive: true });

    assert.equal(findWorkspaceConfigFile(nested), file);
  });

  it("findWorkspaceConfigFile returns null when no file is found", () => {
    assert.equal(findWorkspaceConfigFile(env.tmpDir), null);
  });

  it("loadConfig picks up profile from a workspace file", () => {
    setupProfileDir("work");
    const file = setupWorkspace(env.tmpDir, "work");

    const config = loadConfig(undefined, { cwd: env.tmpDir });

    assert.equal(config.profile, "work");
    assert.equal(config.profileSource.kind, "workspace");
    assert.equal(
      (config.profileSource as { configFile: string }).configFile,
      file,
    );
  });

  it("--profile flag wins over workspace file", () => {
    setupProfileDir("work");
    setupWorkspace(env.tmpDir, "work");

    const config = loadConfig("ops", { cwd: env.tmpDir });

    assert.equal(config.profile, "ops");
    assert.equal(config.profileSource.kind, "flag");
  });

  it("ROBONET_PROFILE env var wins over workspace file", () => {
    setupProfileDir("work");
    setupWorkspace(env.tmpDir, "work");
    process.env.ROBONET_PROFILE = "env-profile";

    const config = loadConfig(undefined, { cwd: env.tmpDir });

    assert.equal(config.profile, "env-profile");
    assert.equal(config.profileSource.kind, "env");
  });

  it("throws when workspace requests a profile that is not set up", () => {
    setupWorkspace(env.tmpDir, "ghost");

    assert.throws(
      () => loadConfig(undefined, { cwd: env.tmpDir }),
      (err: unknown) =>
        err instanceof ConfigurationError &&
        err.message.includes("ghost") &&
        err.message.includes("robonet --profile ghost login"),
    );
  });

  it("throws on malformed workspace JSON", () => {
    const wsDir = path.join(env.tmpDir, ".robonet");
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, "config.json"), "{not json");

    assert.throws(
      () => loadConfig(undefined, { cwd: env.tmpDir }),
      (err: unknown) =>
        err instanceof ConfigurationError &&
        err.message.includes("not valid JSON"),
    );
  });
});
