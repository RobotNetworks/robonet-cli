import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { ConfigurationError } from "./errors.js";

const DEFAULT_ENVIRONMENT = "prod";
const DEFAULT_PROFILE = "default";
const DEFAULT_NETWORK = "public";
const WORKSPACE_CONFIG_DIR = ".robotnet";
const WORKSPACE_CONFIG_FILE = "config.json";

/** How an agent authenticates to a given ASP network. */
export type NetworkAuthMode = "oauth" | "agent-token";

/**
 * A named ASP network the CLI can target.
 *
 * `oauth` networks (e.g. the hosted RobotNet network) authenticate via the
 * usual `robotnet login` flow and **must** carry their own `authBaseUrl`
 * (and almost always `websocketUrl`) — different operators run different
 * auth servers and WebSocket gateways, so these belong to the network, not
 * the profile.
 *
 * `agent-token` networks (a `robotnet network start` instance, or any other
 * ASP network that issues bearer tokens at agent registration time)
 * authenticate per-agent with the token returned by the network at
 * registration. They derive the WebSocket URL from `url` and never consult
 * an OAuth auth server, so `authBaseUrl` / `websocketUrl` should be left
 * unset.
 */
export interface NetworkConfig {
  readonly name: string;
  /** REST API base URL. Required for every network. */
  readonly url: string;
  readonly authMode: NetworkAuthMode;
  /** OAuth authorization server base URL — required when `authMode === "oauth"`. */
  readonly authBaseUrl?: string;
  /** WebSocket handshake URL — required when `authMode === "oauth"`; ignored for `agent-token`. */
  readonly websocketUrl?: string;
}

/** Where the active network selection was resolved from. Surfaced in `config show` for debuggability. */
export type NetworkSource =
  | { readonly kind: "flag" }
  | { readonly kind: "env" }
  | { readonly kind: "workspace"; readonly configFile: string }
  | { readonly kind: "default" };

/**
 * The set of networks every profile knows about by default.
 *
 * - `public`: the hosted RobotNet network, authenticated via OAuth (today's
 *   `robotnet login` flow). Carries its own auth + websocket URLs so it
 *   works out of the box without any profile config.
 * - `local`: a `robotnet network start` instance on the loopback default
 *   port; agents authenticate with the long-lived bearer token issued at
 *   `robotnet admin agent create` time. No OAuth, no separate websocket
 *   gateway — both are derived from `url`.
 *
 * A profile config may add more entries or override these via its `networks`
 * field.
 */
const BUILTIN_NETWORKS: Readonly<Record<string, NetworkConfig>> = {
  public: {
    name: "public",
    url: "https://api.robotnet.ai/v1",
    authMode: "oauth",
    authBaseUrl: "https://auth.robotnet.ai",
    websocketUrl: "wss://ws.robotnet.ai",
  },
  local: {
    name: "local",
    url: "http://127.0.0.1:8723",
    authMode: "agent-token",
  },
};

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

/** Fully resolved CLI configuration: profile, environment, network selection, and filesystem paths. */
export interface CLIConfig {
  readonly profile: string;
  readonly profileSource: ProfileSource;
  readonly environment: string;
  readonly paths: CLIPaths;
  readonly configFile: string;
  readonly tokenStoreFile: string;
  /** The network selected for this invocation. */
  readonly network: NetworkConfig;
  readonly networkSource: NetworkSource;
  /** All networks visible to this profile — built-ins merged with the profile config's `networks` map. */
  readonly networks: Readonly<Record<string, NetworkConfig>>;
}

/** Options accepted by {@link loadConfig}. */
export interface LoadConfigOptions {
  readonly cwd?: string;
  /** Override the network selection — wired to the top-level `--network <name>` flag. */
  readonly networkName?: string;
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
): { name: string; source: ProfileSource; workspaceFile: string | null } {
  const flag = (profileName ?? "").trim();
  if (flag) {
    return { name: flag, source: { kind: "flag" }, workspaceFile: findWorkspaceConfigFile(cwd) };
  }

  const env = (process.env.ROBOTNET_PROFILE ?? "").trim();
  if (env) {
    return { name: env, source: { kind: "env" }, workspaceFile: findWorkspaceConfigFile(cwd) };
  }

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
        workspaceFile,
      };
    }
    return { name: DEFAULT_PROFILE, source: { kind: "default" }, workspaceFile };
  }

  return { name: DEFAULT_PROFILE, source: { kind: "default" }, workspaceFile: null };
}

function parseAuthMode(value: unknown, networkName: string, configFile: string): NetworkAuthMode {
  if (value === "oauth" || value === "agent-token") return value;
  throw new ConfigurationError(
    `Network "${networkName}" in ${configFile} has an invalid auth_mode — expected "oauth" or "agent-token", got ${JSON.stringify(value)}`,
  );
}

function parseOptionalUrlField(
  entry: Record<string, unknown>,
  field: string,
  networkName: string,
  configFile: string,
): string | undefined {
  const raw = entry[field];
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !raw.trim()) {
    throw new ConfigurationError(
      `Network "${networkName}" in ${configFile} has an invalid \`${field}\` — expected a non-empty string`,
    );
  }
  return raw.trim();
}

/** Merge the built-in network map with any user-defined entries from the per-profile config file. */
function loadNetworksFromProfile(
  profilePayload: Record<string, unknown>,
  configFile: string,
): Readonly<Record<string, NetworkConfig>> {
  const merged: Record<string, NetworkConfig> = { ...BUILTIN_NETWORKS };

  const raw = profilePayload["networks"];
  if (raw === undefined) return merged;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigurationError(
      `\`networks\` in ${configFile} must be an object mapping name → { url, auth_mode, ... }`,
    );
  }

  for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new ConfigurationError(
        `Network "${name}" in ${configFile} must be an object with \`url\` and \`auth_mode\` fields`,
      );
    }
    const e = entry as Record<string, unknown>;
    const url = e["url"];
    if (typeof url !== "string" || !url.trim()) {
      throw new ConfigurationError(
        `Network "${name}" in ${configFile} is missing a \`url\` field`,
      );
    }
    const authMode = parseAuthMode(e["auth_mode"], name, configFile);
    const authBaseUrl = parseOptionalUrlField(e, "auth_base_url", name, configFile);
    const websocketUrl = parseOptionalUrlField(e, "websocket_url", name, configFile);

    if (authMode === "oauth" && authBaseUrl === undefined) {
      throw new ConfigurationError(
        `Network "${name}" in ${configFile} has \`auth_mode: "oauth"\` but no \`auth_base_url\` field. ` +
          `Add the OAuth authorization server URL (e.g. "https://auth.example.com").`,
      );
    }

    merged[name] = {
      name,
      url: url.trim(),
      authMode,
      ...(authBaseUrl !== undefined ? { authBaseUrl } : {}),
      ...(websocketUrl !== undefined ? { websocketUrl } : {}),
    };
  }

  return merged;
}

/**
 * After network resolution, apply per-invocation env-var overrides
 * (`ROBOTNET_API_BASE_URL` / `ROBOTNET_AUTH_BASE_URL` / `ROBOTNET_WEBSOCKET_URL`)
 * onto the resolved network. These are testing escape hatches — they let
 * a script point at a non-prod surface for one run without editing config.
 */
function applyEndpointEnvOverrides(network: NetworkConfig): NetworkConfig {
  const apiOverride = (process.env.ROBOTNET_API_BASE_URL ?? "").trim();
  const authOverride = (process.env.ROBOTNET_AUTH_BASE_URL ?? "").trim();
  const wsOverride = (process.env.ROBOTNET_WEBSOCKET_URL ?? "").trim();
  if (!apiOverride && !authOverride && !wsOverride) return network;
  return {
    ...network,
    ...(apiOverride ? { url: apiOverride } : {}),
    ...(authOverride ? { authBaseUrl: authOverride } : {}),
    ...(wsOverride ? { websocketUrl: wsOverride } : {}),
  };
}

interface NetworkResolution {
  readonly network: NetworkConfig;
  readonly source: NetworkSource;
}

function resolveNetwork(
  networks: Readonly<Record<string, NetworkConfig>>,
  args: {
    readonly flag: string | undefined;
    readonly workspaceFile: string | null;
    readonly workspaceNetwork: string | undefined;
  },
): NetworkResolution {
  const fail = (name: string, where: string): never => {
    throw new ConfigurationError(
      `Network "${name}" referenced from ${where} is not defined. ` +
        `Add it to the \`networks\` map in your profile config, or pick one of: ${Object.keys(networks).sort().join(", ")}.`,
    );
  };

  const flag = (args.flag ?? "").trim();
  if (flag) {
    const found = networks[flag];
    if (!found) fail(flag, "--network flag");
    return { network: networks[flag], source: { kind: "flag" } };
  }

  const env = (process.env.ROBOTNET_NETWORK ?? "").trim();
  if (env) {
    if (!networks[env]) fail(env, "ROBOTNET_NETWORK env var");
    return { network: networks[env], source: { kind: "env" } };
  }

  if (args.workspaceNetwork && args.workspaceFile) {
    if (!networks[args.workspaceNetwork]) {
      fail(args.workspaceNetwork, `workspace file ${args.workspaceFile}`);
    }
    return {
      network: networks[args.workspaceNetwork],
      source: { kind: "workspace", configFile: args.workspaceFile },
    };
  }

  return { network: networks[DEFAULT_NETWORK], source: { kind: "default" } };
}

/**
 * Load configuration for the given profile, merging (in precedence order)
 * env vars, `config.json`, and built-in defaults.
 *
 * Profile name resolution: `--profile` flag > `ROBOTNET_PROFILE` env var >
 * workspace `.robotnet/config.json` `profile` field (walked up from `cwd`)
 * > `"default"`.
 *
 * Network resolution: `options.networkName` (typically the `--network` flag) >
 * `ROBOTNET_NETWORK` env var > workspace `.robotnet/config.json` `network`
 * field > the built-in `"public"` network.
 *
 * Per-network endpoint env overrides (`ROBOTNET_API_BASE_URL`,
 * `ROBOTNET_AUTH_BASE_URL`, `ROBOTNET_WEBSOCKET_URL`) are applied to the
 * resolved network after network selection — useful for one-shot
 * redirection at a staging surface without editing config.
 */
export function loadConfig(
  profileName?: string,
  options?: LoadConfigOptions,
): CLIConfig {
  const cwd = options?.cwd ?? process.cwd();
  const { name: profile, source: profileSource, workspaceFile } = resolveProfile(
    profileName,
    cwd,
  );

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

  const networks = loadNetworksFromProfile(payload, configFile);

  let workspaceNetwork: string | undefined;
  if (workspaceFile) {
    const wsPayload = loadJsonFile(workspaceFile);
    workspaceNetwork = getNestedString(wsPayload, "network");
  }

  const { network: resolvedNetwork, source: networkSource } = resolveNetwork(networks, {
    flag: options?.networkName,
    workspaceFile,
    workspaceNetwork,
  });

  const network = applyEndpointEnvOverrides(resolvedNetwork);

  return {
    profile,
    profileSource,
    environment,
    paths,
    configFile,
    tokenStoreFile: path.join(paths.configDir, "auth.json"),
    network,
    networkSource,
    networks,
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

function networkSourceLabel(source: NetworkSource): string {
  switch (source.kind) {
    case "flag":
      return "--network flag";
    case "env":
      return "ROBOTNET_NETWORK env var";
    case "workspace":
      return `workspace file ${source.configFile}`;
    case "default":
      return "built-in default";
  }
}

function networkSourceJson(source: NetworkSource): Record<string, unknown> {
  if (source.kind === "workspace") {
    return { kind: source.kind, config_file: source.configFile };
  }
  return { kind: source.kind };
}

function networkToJson(net: NetworkConfig): Record<string, unknown> {
  return {
    name: net.name,
    url: net.url,
    auth_mode: net.authMode,
    auth_base_url: net.authBaseUrl ?? null,
    websocket_url: net.websocketUrl ?? null,
  };
}

/** Serialize a config to a snake_case JSON object suitable for machine-readable output. */
export function configToJson(config: CLIConfig): Record<string, unknown> {
  const networks: Record<string, unknown> = {};
  for (const [name, n] of Object.entries(config.networks)) {
    networks[name] = networkToJson(n);
  }
  return {
    profile: config.profile,
    profile_source: profileSourceJson(config.profileSource),
    environment: config.environment,
    config_file: config.configFile,
    token_store_file: config.tokenStoreFile,
    network: networkToJson(config.network),
    network_source: networkSourceJson(config.networkSource),
    networks,
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
    network: config.network.name,
    network_url: config.network.url,
    network_auth_mode: config.network.authMode,
    network_auth_base_url: config.network.authBaseUrl ?? "(n/a)",
    network_websocket_url: config.network.websocketUrl ?? "(derived from url)",
    network_source: networkSourceLabel(config.networkSource),
    config_dir: config.paths.configDir,
    state_dir: config.paths.stateDir,
    logs_dir: config.paths.logsDir,
    run_dir: config.paths.runDir,
  };
}
