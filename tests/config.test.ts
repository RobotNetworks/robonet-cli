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
  it("default profile uses root robotnet dirs", () => {
    const paths = defaultPaths("default");

    assert.equal(paths.configDir, path.join(env.tmpDir, "config", "robotnet"));
    assert.equal(paths.stateDir, path.join(env.tmpDir, "state", "robotnet"));
  });

  it("named profile uses profiles subdirectories", () => {
    const paths = defaultPaths("work");

    assert.equal(
      paths.configDir,
      path.join(env.tmpDir, "config", "robotnet", "profiles", "work"),
    );
    assert.equal(
      paths.stateDir,
      path.join(env.tmpDir, "state", "robotnet", "profiles", "work"),
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
        "robotnet",
        "profiles",
        "ops",
        "auth.json",
      ),
    );
  });

  it("ROBOTNET_API_BASE_URL env override patches the resolved network's `url`", () => {
    process.env.ROBOTNET_API_BASE_URL = "https://api.example.test/v1";

    const config = loadConfig(undefined, { cwd: env.tmpDir });

    assert.equal(config.network.url, "https://api.example.test/v1");
  });

  it("ROBOTNET_AUTH_BASE_URL / ROBOTNET_WEBSOCKET_URL env overrides patch the resolved network", () => {
    process.env.ROBOTNET_AUTH_BASE_URL = "https://auth.example.test";
    process.env.ROBOTNET_WEBSOCKET_URL = "wss://ws.example.test";

    const config = loadConfig(undefined, { cwd: env.tmpDir });

    assert.equal(config.network.authBaseUrl, "https://auth.example.test");
    assert.equal(config.network.websocketUrl, "wss://ws.example.test");
  });

  it("falls back to default profile when nothing is set", () => {
    const config = loadConfig(undefined, { cwd: env.tmpDir });

    assert.equal(config.profile, "default");
    assert.equal(config.profileSource.kind, "default");
  });

  it("reads profile from ROBOTNET_PROFILE env var", () => {
    process.env.ROBOTNET_PROFILE = "work";

    const config = loadConfig(undefined, { cwd: env.tmpDir });

    assert.equal(config.profile, "work");
    assert.equal(config.profileSource.kind, "env");
  });
});

describe("workspace profile config", () => {
  function setupWorkspace(dir: string, profileName: string): string {
    const wsDir = path.join(dir, ".robotnet");
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

  it("ROBOTNET_PROFILE env var wins over workspace file", () => {
    setupProfileDir("work");
    setupWorkspace(env.tmpDir, "work");
    process.env.ROBOTNET_PROFILE = "env-profile";

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
        err.message.includes("robotnet --profile ghost login"),
    );
  });

  it("throws on malformed workspace JSON", () => {
    const wsDir = path.join(env.tmpDir, ".robotnet");
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

describe("network resolution", () => {
  function writeProfileConfig(
    profile: string,
    payload: Record<string, unknown>,
  ): string {
    const dir = defaultPaths(profile).configDir;
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, JSON.stringify(payload));
    return file;
  }

  it("falls back to the built-in `public` network with no config", () => {
    const config = loadConfig(undefined, { cwd: env.tmpDir });

    assert.equal(config.network.name, "public");
    assert.equal(config.network.authMode, "oauth");
    assert.equal(config.networkSource.kind, "default");
    // Built-in `local` is always visible too.
    assert.equal(config.networks.local.url, "http://127.0.0.1:8723");
    assert.equal(config.networks.local.authMode, "agent-token");
  });

  it("--network flag selects a named network", () => {
    const config = loadConfig(undefined, {
      cwd: env.tmpDir,
      networkName: "local",
    });

    assert.equal(config.network.name, "local");
    assert.equal(config.networkSource.kind, "flag");
  });

  it("--network flag wins over ROBOTNET_NETWORK env var", () => {
    process.env.ROBOTNET_NETWORK = "public";
    const config = loadConfig(undefined, {
      cwd: env.tmpDir,
      networkName: "local",
    });

    assert.equal(config.network.name, "local");
    assert.equal(config.networkSource.kind, "flag");
  });

  it("ROBOTNET_NETWORK env var selects a named network when no flag is set", () => {
    process.env.ROBOTNET_NETWORK = "local";
    const config = loadConfig(undefined, { cwd: env.tmpDir });

    assert.equal(config.network.name, "local");
    assert.equal(config.networkSource.kind, "env");
  });

  it("workspace `network` field selects a named network when no flag/env override", () => {
    const wsDir = path.join(env.tmpDir, ".robotnet");
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(
      path.join(wsDir, "config.json"),
      JSON.stringify({ network: "local" }),
    );

    const config = loadConfig(undefined, { cwd: env.tmpDir });

    assert.equal(config.network.name, "local");
    assert.equal(config.networkSource.kind, "workspace");
  });

  it("profile config can define an additional OAuth network with auth + websocket URLs", () => {
    writeProfileConfig("default", {
      networks: {
        staging: {
          url: "https://staging.example/v1",
          auth_mode: "oauth",
          auth_base_url: "https://auth.staging.example",
          websocket_url: "wss://ws.staging.example",
        },
      },
    });

    const config = loadConfig(undefined, {
      cwd: env.tmpDir,
      networkName: "staging",
    });

    assert.equal(config.network.url, "https://staging.example/v1");
    assert.equal(config.network.authMode, "oauth");
    assert.equal(config.network.authBaseUrl, "https://auth.staging.example");
    assert.equal(config.network.websocketUrl, "wss://ws.staging.example");
    assert.equal(config.networks.staging.url, "https://staging.example/v1");
    // Built-ins are still visible alongside the user-defined entry.
    assert.equal(config.networks.public.authMode, "oauth");
    assert.equal(config.networks.public.authBaseUrl, "https://auth.robotnet.ai");
  });

  it("rejects an oauth network missing `auth_base_url`", () => {
    writeProfileConfig("default", {
      networks: {
        broken: { url: "https://staging.example/v1", auth_mode: "oauth" },
      },
    });

    assert.throws(
      () => loadConfig(undefined, { cwd: env.tmpDir, networkName: "broken" }),
      (err: unknown) =>
        err instanceof ConfigurationError &&
        err.message.includes('Network "broken"') &&
        err.message.includes("auth_base_url"),
    );
  });

  it("an agent-token network does NOT require auth_base_url / websocket_url", () => {
    writeProfileConfig("default", {
      networks: {
        custom: { url: "http://127.0.0.1:9000", auth_mode: "agent-token" },
      },
    });

    const config = loadConfig(undefined, {
      cwd: env.tmpDir,
      networkName: "custom",
    });

    assert.equal(config.network.url, "http://127.0.0.1:9000");
    assert.equal(config.network.authMode, "agent-token");
    assert.equal(config.network.authBaseUrl, undefined);
    assert.equal(config.network.websocketUrl, undefined);
  });

  it("profile config can override a built-in network's URL", () => {
    writeProfileConfig("default", {
      networks: {
        local: { url: "http://127.0.0.1:9999", auth_mode: "agent-token" },
      },
    });

    const config = loadConfig(undefined, {
      cwd: env.tmpDir,
      networkName: "local",
    });

    assert.equal(config.network.url, "http://127.0.0.1:9999");
  });

  it("--network with an unknown name fails with a helpful error listing the known networks", () => {
    assert.throws(
      () =>
        loadConfig(undefined, { cwd: env.tmpDir, networkName: "ghost" }),
      (err: unknown) =>
        err instanceof ConfigurationError &&
        err.message.includes('Network "ghost"') &&
        err.message.includes("--network flag") &&
        err.message.includes("local") &&
        err.message.includes("public"),
    );
  });

  it("rejects a network with a missing url field", () => {
    writeProfileConfig("default", {
      networks: { broken: { auth_mode: "oauth" } },
    });

    assert.throws(
      () => loadConfig(undefined, { cwd: env.tmpDir }),
      (err: unknown) =>
        err instanceof ConfigurationError &&
        err.message.includes('Network "broken"') &&
        err.message.includes("`url`"),
    );
  });

  it("rejects a network with an invalid auth_mode", () => {
    writeProfileConfig("default", {
      networks: {
        broken: { url: "http://example", auth_mode: "magic-beans" },
      },
    });

    assert.throws(
      () => loadConfig(undefined, { cwd: env.tmpDir }),
      (err: unknown) =>
        err instanceof ConfigurationError &&
        err.message.includes("auth_mode"),
    );
  });
});
