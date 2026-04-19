import { discoverOAuth } from "./auth/discovery.js";
import { loadToken } from "./auth/token-store.js";
import type { CLIConfig } from "./config.js";
import { DISCOVERY_TIMEOUT_MS } from "./endpoints.js";

/** Result of a single diagnostic check: stable machine-readable `name`, pass/fail `ok`, and a human-readable `detail`. */
export interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

/** Run the full diagnostic suite: config paths, endpoint reachability, OAuth discovery, and stored auth. Never throws — failures are surfaced as `ok: false` check entries. */
export async function runDoctor(config: CLIConfig): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  checks.push(...configChecks(config));
  checks.push(...(await endpointChecks(config)));
  checks.push(...(await discoveryChecks(config)));
  checks.push(...authChecks(config));

  return checks;
}

function configChecks(config: CLIConfig): DoctorCheck[] {
  return [
    {
      name: "config_paths",
      ok: true,
      detail:
        `config=${config.paths.configDir} ` +
        `state=${config.paths.stateDir} ` +
        `logs=${config.paths.logsDir} ` +
        `run=${config.paths.runDir}`,
    },
  ];
}

async function endpointChecks(config: CLIConfig): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const httpTargets = [
    { name: "api", url: `${config.endpoints.apiBaseUrl.replace(/\/+$/, "")}/agents/me` },
    {
      name: "mcp",
      url: `${config.endpoints.mcpBaseUrl.replace(/\/+$/, "")}/health`,
    },
    {
      name: "auth",
      url: `${config.endpoints.authBaseUrl.replace(/\/+$/, "")}/.well-known/oauth-authorization-server`,
    },
  ];

  for (const target of httpTargets) {
    try {
      const response = await fetch(target.url, {
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
        redirect: "follow",
      });
      let expectedOk = response.status < 500;
      if (target.name === "api") {
        expectedOk = [200, 401, 403].includes(response.status);
      }
      checks.push({
        name: `endpoint_${target.name}`,
        ok: expectedOk,
        detail: `${target.url} status=${response.status}`,
      });
    } catch (err) {
      checks.push({
        name: `endpoint_${target.name}`,
        ok: false,
        detail: `${target.url} error=${err}`,
      });
    }
  }

  checks.push({
    name: "endpoint_websocket",
    ok: true,
    detail: config.endpoints.websocketUrl,
  });

  return checks;
}

async function discoveryChecks(config: CLIConfig): Promise<DoctorCheck[]> {
  try {
    const discovery = await discoverOAuth(config.endpoints);
    return [
      {
        name: "oauth_discovery",
        ok: true,
        detail:
          `token_endpoint=${discovery.tokenEndpoint} ` +
          `mcp_resource=${discovery.mcpResource} ` +
          `api_resource=${discovery.apiResource ?? "n/a"} ` +
          `websocket_resource=${discovery.websocketResource ?? "n/a"}`,
      },
    ];
  } catch (err) {
    return [
      {
        name: "oauth_discovery",
        ok: false,
        detail: String(err),
      },
    ];
  }
}

function authChecks(config: CLIConfig): DoctorCheck[] {
  const stored = loadToken(config.tokenStoreFile);
  if (!stored) {
    return [
      {
        name: "stored_auth",
        ok: false,
        detail: `no stored token metadata at ${config.tokenStoreFile}`,
      },
    ];
  }
  return [
    {
      name: "stored_auth",
      ok: true,
      detail:
        `client_id=${stored.clientId} ` +
        `resource=${stored.resource} ` +
        `token_endpoint=${stored.tokenEndpoint}`,
    },
  ];
}
