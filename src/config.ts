import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { EndpointConfig } from "./endpoints.js";
import { ConfigurationError } from "./errors.js";

const DEFAULT_API_BASE_URL = "https://api.robotnet.works/v1";
const DEFAULT_AUTH_BASE_URL = "https://auth.robotnet.works";
const DEFAULT_WEBSOCKET_URL = "wss://ws.robotnet.works";
const DEFAULT_ENVIRONMENT = "prod";
const DEFAULT_PROFILE = "default";
const WORKSPACE_CONFIG_DIR = ".robotnet";
const WORKSPACE_CONFIG_FILE = "config.json";

/** Where the active profile name was resolved from. Surfaced in `config show` for debuggability. */
export type ProfileSource =
  | { readonly kind: "flag" }
  | { readonly kind: "env" }
  | { readonly kind: "workspace"; readonly configFile: string }
  | { readonly kind: "default" };

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
  readonly profileSource: ProfileSource;
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
  const baseConfigDir = path.join(xdgPath("XDG_CONFIG_HOME", ".config"), "robotnet");
  const baseStateDir = path.join(xdgPath("XDG_STATE_HOME", ".local/state"), "robotnet");

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

/** Walk upward from `startDir` looking for a `.robotnet/config.json` workspace file. Halts at `$HOME` and at the filesystem root. Returns null if none found. */
export function findWorkspaceConfigFile(startDir: string): string | null {
  let current = path.resolve(startDir);
  const home = path.resolve(os.homedir());
  while (true) {
    const candidate = path.join(current, WORKSPACE_CONFIG_DIR, WORKSPACE_CONFIG_FILE);
    if (fs.existsSync(candidate)) return candidate;
    if (current === home) return null;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolveProfile(
  profileName: string | undefined,
  cwd: string,
): { name: string; source: ProfileSource } {
  const flag = (profileName ?? "").trim();
  if (flag) return { name: flag, source: { kind: "flag" } };

  const env = (process.env.ROBOTNET_PROFILE ?? "").trim();
  if (env) return { name: env, source: { kind: "env" } };

  const workspaceFile = findWorkspaceConfigFile(cwd);
  if (workspaceFile) {
    let payload: Record<string, unknown>;
    try {
      payload = loadJsonFile(workspaceFile);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new ConfigurationError(
        `Workspace profile config at ${workspaceFile} is not valid JSON: ${detail}`,
      );
    }
    const wsProfile = getNestedString(payload, "profile");
    if (wsProfile) {
      return {
        name: wsProfile,
        source: { kind: "workspace", configFile: workspaceFile },
      };
    }
  }

  return { name: DEFAULT_PROFILE, source: { kind: "default" } };
}

/** Load configuration for the given profile, merging (in precedence order) env vars, `config.json`, and built-in defaults. Profile name resolution: `--profile` flag > `ROBOTNET_PROFILE` env var > workspace `.robotnet/config.json` (walked up from `cwd`) > `"default"`. */
export function loadConfig(
  profileName?: string,
  options?: { cwd?: string },
): CLIConfig {
  const cwd = options?.cwd ?? process.cwd();
  const { name: profile, source: profileSource } = resolveProfile(profileName, cwd);

  if (profileSource.kind === "workspace") {
    const profilePaths = defaultPaths(profile);
    if (!fs.existsSync(profilePaths.configDir)) {
      throw new ConfigurationError(
        `Workspace at ${profileSource.configFile} requests profile "${profile}", ` +
          `but no such profile is set up. Run \`robotnet --profile ${profile} login\` ` +
          `to create it, or remove/edit the workspace file.`,
      );
    }
  }

  const paths = defaultPaths(profile);
  const configFile = path.join(paths.configDir, "config.json");
  const payload = loadJsonFile(configFile);

  const environment =
    (process.env.ROBOTNET_ENVIRONMENT ?? "").trim() ||
    getNestedString(payload, "environment") ||
    DEFAULT_ENVIRONMENT;

  const endpoints: EndpointConfig = {
    apiBaseUrl:
      (process.env.ROBOTNET_API_BASE_URL ?? "").trim() ||
      getNestedString(payload, "endpoints", "api_base_url") ||
      DEFAULT_API_BASE_URL,
    authBaseUrl:
      (process.env.ROBOTNET_AUTH_BASE_URL ?? "").trim() ||
      getNestedString(payload, "endpoints", "auth_base_url") ||
      DEFAULT_AUTH_BASE_URL,
    websocketUrl:
      (process.env.ROBOTNET_WEBSOCKET_URL ?? "").trim() ||
      getNestedString(payload, "endpoints", "websocket_url") ||
      DEFAULT_WEBSOCKET_URL,
  };

  return {
    profile,
    profileSource,
    environment,
    endpoints,
    paths,
    configFile,
    tokenStoreFile: path.join(paths.configDir, "auth.json"),
  };
}

function profileSourceLabel(source: ProfileSource): string {
  switch (source.kind) {
    case "flag":
      return "--profile flag";
    case "env":
      return "ROBOTNET_PROFILE env var";
    case "workspace":
      return `workspace file ${source.configFile}`;
    case "default":
      return "built-in default";
  }
}

function profileSourceJson(source: ProfileSource): Record<string, unknown> {
  if (source.kind === "workspace") {
    return { kind: "workspace", config_file: source.configFile };
  }
  return { kind: source.kind };
}

/** Serialize a config to a snake_case JSON object suitable for machine-readable output. */
export function configToJson(config: CLIConfig): Record<string, unknown> {
  return {
    profile: config.profile,
    profile_source: profileSourceJson(config.profileSource),
    environment: config.environment,
    config_file: config.configFile,
    token_store_file: config.tokenStoreFile,
    endpoints: {
      api_base_url: config.endpoints.apiBaseUrl,
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

/** Flatten a config into a single-level string map for human-readable display (e.g. `robotnet config show`). */
export function configToHumanPayload(config: CLIConfig): Record<string, string> {
  return {
    profile_source: profileSourceLabel(config.profileSource),
    environment: config.environment,
    config_file: config.configFile,
    token_store_file: config.tokenStoreFile,
    api_base_url: config.endpoints.apiBaseUrl,
    auth_base_url: config.endpoints.authBaseUrl,
    websocket_url: config.endpoints.websocketUrl,
    config_dir: config.paths.configDir,
    state_dir: config.paths.stateDir,
    logs_dir: config.paths.logsDir,
    run_dir: config.paths.runDir,
  };
}
