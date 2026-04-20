import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { EndpointConfig } from "./endpoints.js";

const DEFAULT_API_BASE_URL = "https://api.robotnet.works/v1";
const DEFAULT_MCP_BASE_URL = "https://mcp.robotnet.works/mcp";
const DEFAULT_AUTH_BASE_URL = "https://auth.robotnet.works";
const DEFAULT_WEBSOCKET_URL = "wss://ws.robotnet.works";
const DEFAULT_ENVIRONMENT = "prod";
const DEFAULT_PROFILE = "default";

/** XDG-compliant filesystem locations the CLI uses for config, state, logs, and runtime files. */
export interface CLIPaths {
  readonly configDir: string;
  readonly stateDir: string;
  readonly logsDir: string;
  readonly runDir: string;
}

/** Fully resolved CLI configuration: profile, environment, endpoints, and filesystem paths. */
export interface CLIConfig {
  readonly profile: string;
  readonly environment: string;
  readonly endpoints: EndpointConfig;
  readonly paths: CLIPaths;
  readonly configFile: string;
  readonly tokenStoreFile: string;
}

function xdgPath(envVar: string, defaultSuffix: string): string {
  const value = (process.env[envVar] ?? "").trim();
  if (value) {
    if (value.startsWith("~")) {
      return path.join(os.homedir(), value.slice(1));
    }
    return value;
  }
  return path.join(os.homedir(), defaultSuffix);
}

/** Resolve XDG-compliant default paths for the given profile; non-default profiles nest under a `profiles/` subdir. */
export function defaultPaths(profile: string = DEFAULT_PROFILE): CLIPaths {
  const baseConfigDir = path.join(xdgPath("XDG_CONFIG_HOME", ".config"), "robonet");
  const baseStateDir = path.join(xdgPath("XDG_STATE_HOME", ".local/state"), "robonet");

  let configDir: string;
  let stateDir: string;
  if (profile === DEFAULT_PROFILE) {
    configDir = baseConfigDir;
    stateDir = baseStateDir;
  } else {
    configDir = path.join(baseConfigDir, "profiles", profile);
    stateDir = path.join(baseStateDir, "profiles", profile);
  }

  return {
    configDir,
    stateDir,
    logsDir: path.join(stateDir, "logs"),
    runDir: path.join(stateDir, "run"),
  };
}

function loadJsonFile(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  const raw = fs.readFileSync(filePath, "utf-8");
  const payload: unknown = JSON.parse(raw);
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return {};
  }
  return payload as Record<string, unknown>;
}

function getNestedString(
  payload: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  let current: unknown = payload;
  for (const key of keys) {
    if (typeof current !== "object" || current === null || !(key in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  if (typeof current === "string" && current.trim()) {
    return current.trim();
  }
  return undefined;
}

function resolveProfileName(profileName?: string): string {
  return (
    (profileName ?? "").trim() ||
    (process.env.ROBONET_PROFILE ?? "").trim() ||
    DEFAULT_PROFILE
  );
}

/** Load configuration for the given profile, merging (in precedence order) env vars, `config.json`, and built-in defaults. */
export function loadConfig(profileName?: string): CLIConfig {
  const profile = resolveProfileName(profileName);
  const paths = defaultPaths(profile);
  const configFile = path.join(paths.configDir, "config.json");
  const payload = loadJsonFile(configFile);

  const environment =
    (process.env.ROBONET_ENVIRONMENT ?? "").trim() ||
    getNestedString(payload, "environment") ||
    DEFAULT_ENVIRONMENT;

  const endpoints: EndpointConfig = {
    apiBaseUrl:
      (process.env.ROBONET_API_BASE_URL ?? "").trim() ||
      getNestedString(payload, "endpoints", "api_base_url") ||
      DEFAULT_API_BASE_URL,
    mcpBaseUrl:
      (process.env.ROBONET_MCP_BASE_URL ?? "").trim() ||
      getNestedString(payload, "endpoints", "mcp_base_url") ||
      DEFAULT_MCP_BASE_URL,
    authBaseUrl:
      (process.env.ROBONET_AUTH_BASE_URL ?? "").trim() ||
      getNestedString(payload, "endpoints", "auth_base_url") ||
      DEFAULT_AUTH_BASE_URL,
    websocketUrl:
      (process.env.ROBONET_WEBSOCKET_URL ?? "").trim() ||
      getNestedString(payload, "endpoints", "websocket_url") ||
      DEFAULT_WEBSOCKET_URL,
  };

  return {
    profile,
    environment,
    endpoints,
    paths,
    configFile,
    tokenStoreFile: path.join(paths.configDir, "auth.json"),
  };
}

/** Serialize a config to a snake_case JSON object suitable for machine-readable output. */
export function configToJson(config: CLIConfig): Record<string, unknown> {
  return {
    profile: config.profile,
    environment: config.environment,
    config_file: config.configFile,
    token_store_file: config.tokenStoreFile,
    endpoints: {
      api_base_url: config.endpoints.apiBaseUrl,
      mcp_base_url: config.endpoints.mcpBaseUrl,
      auth_base_url: config.endpoints.authBaseUrl,
      websocket_url: config.endpoints.websocketUrl,
    },
    paths: {
      config_dir: config.paths.configDir,
      state_dir: config.paths.stateDir,
      logs_dir: config.paths.logsDir,
      run_dir: config.paths.runDir,
    },
  };
}

/** Flatten a config into a single-level string map for human-readable display (e.g. `robonet config show`). */
export function configToHumanPayload(config: CLIConfig): Record<string, string> {
  return {
    environment: config.environment,
    config_file: config.configFile,
    token_store_file: config.tokenStoreFile,
    api_base_url: config.endpoints.apiBaseUrl,
    mcp_base_url: config.endpoints.mcpBaseUrl,
    auth_base_url: config.endpoints.authBaseUrl,
    websocket_url: config.endpoints.websocketUrl,
    config_dir: config.paths.configDir,
    state_dir: config.paths.stateDir,
    logs_dir: config.paths.logsDir,
    run_dir: config.paths.runDir,
  };
}
