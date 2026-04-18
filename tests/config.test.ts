import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as path from "node:path";
import { defaultPaths, loadConfig } from "../src/config.js";
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
    const config = loadConfig("ops");

    assert.equal(config.profile, "ops");
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

    const config = loadConfig();

    assert.equal(config.endpoints.apiBaseUrl, "https://api.example.test/v1");
  });
});
