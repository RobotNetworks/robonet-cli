import { describe, it } from "node:test";
import * as assert from "node:assert/strict";

import { assertNetworkSupportsOAuthLogin } from "../src/commands/login.js";
import type { CLIConfig, NetworkConfig } from "../src/config.js";

function makeConfig(args: {
  active: NetworkConfig;
  others?: readonly NetworkConfig[];
}): CLIConfig {
  const networks: Record<string, NetworkConfig> = { [args.active.name]: args.active };
  for (const n of args.others ?? []) networks[n.name] = n;
  return {
    profile: "default",
    profileSource: { kind: "default" },
    environment: "prod",
    paths: {
      configDir: "/tmp/cfg",
      stateDir: "/tmp/state",
      logsDir: "/tmp/logs",
      runDir: "/tmp/run",
    },
    configFile: "/tmp/cfg/config.json",
    tokenStoreFile: "/tmp/cfg/auth.json",
    network: args.active,
    networkSource: { kind: "default" },
    networks,
  };
}

const PUBLIC: NetworkConfig = {
  name: "public",
  url: "https://api.example/v1",
  authMode: "oauth",
  authBaseUrl: "https://auth.example",
  websocketUrl: "wss://ws.example",
};
const LOCAL: NetworkConfig = {
  name: "local",
  url: "http://127.0.0.1:8723",
  authMode: "agent-token",
};

describe("assertNetworkSupportsOAuthLogin", () => {
  it("accepts an OAuth network", () => {
    assert.doesNotThrow(() =>
      assertNetworkSupportsOAuthLogin(makeConfig({ active: PUBLIC })),
    );
  });

  it("refuses an agent-token network and points at the right OAuth network", () => {
    const config = makeConfig({ active: LOCAL, others: [PUBLIC] });
    assert.throws(
      () => assertNetworkSupportsOAuthLogin(config),
      (err: unknown) =>
        err instanceof Error &&
        err.message.includes('"local" uses agent-token auth') &&
        err.message.includes("--network public") &&
        err.message.includes("robotnet agent create"),
    );
  });

  it("lists all OAuth networks when more than one is configured", () => {
    const config = makeConfig({
      active: LOCAL,
      others: [
        PUBLIC,
        { name: "staging", url: "https://api.staging/v1", authMode: "oauth" },
      ],
    });
    assert.throws(
      () => assertNetworkSupportsOAuthLogin(config),
      (err: unknown) =>
        err instanceof Error &&
        err.message.includes("Available OAuth networks: public, staging"),
    );
  });

  it("omits the suggestion when no OAuth network is configured at all", () => {
    const config = makeConfig({ active: LOCAL });
    assert.throws(
      () => assertNetworkSupportsOAuthLogin(config),
      (err: unknown) =>
        err instanceof Error &&
        err.message.includes('"local" uses agent-token auth') &&
        !err.message.includes("Try:") &&
        !err.message.includes("Available OAuth networks"),
    );
  });
});
