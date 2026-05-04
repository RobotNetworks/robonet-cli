import { Command } from "commander";

import { fetchAccountAgents } from "../auth/account-agents.js";
import { discoverOAuth } from "../auth/discovery.js";
import { performPkceLogin } from "../auth/pkce.js";
import { enrollAgentClientCredentials, enrollAgentPkce } from "../asp/agent-login.js";
import { assertValidHandle, handleArg } from "../asp/handles.js";
import type { CLIConfig } from "../config.js";
import { openProcessCredentialStore } from "../credentials/lifecycle.js";
import type { CredentialStore } from "../credentials/store.js";
import { loadConfigFromRoot } from "./asp-shared.js";
import { pickAgent } from "./agent-picker.js";
import { RobotNetCLIError } from "../errors.js";
import { renderKeyValues } from "../output/formatters.js";
import { renderJson } from "../output/json-output.js";
import {
  clientIdOption,
  clientSecretOption,
  jsonOption,
  profileTitle,
  resolveClientSecret,
  scopeOption,
} from "./shared.js";

/**
 * `robotnet login` — establish a credential, either for the human user or
 * for a specific agent.
 *
 * Surface (final):
 *   robotnet login                                  → user PKCE
 *   robotnet login --agent @x.y                     → agent PKCE
 *   robotnet login --agent @x.y --client-id ...     → agent client_credentials
 *   robotnet login show [--agent @x.y]              → status
 *   robotnet logout [--agent @x.y | --all]          → remove credentials
 *
 * Storage state (transitional):
 *   - User PKCE writes today's `auth.json` (legacy single-file store).
 *   - Agent flows are stubbed pending the shared SQLite credential store.
 *     Help text and error messages reflect this so the CLI surface is
 *     accurate from this PR forward.
 */
export function registerLoginCommand(program: Command): void {
  program.addCommand(makeLoginCmd());
  program.addCommand(makeLogoutCmd());
}

// ── login ───────────────────────────────────────────────────────────────────

function makeLoginCmd(): Command {
  const login = new Command("login")
    .description(
      "Sign in. Without --agent: user PKCE. With --agent: that agent's credential " +
        "(PKCE by default; client_credentials when --client-id/--client-secret are supplied).",
    )
    // Optional value form: `--agent` alone triggers the picker (asks
     // /accounts/me/agents), `--agent @x.y` skips it. We can't use commander's
     // built-in argParser for the optional case, so we validate the handle
     // shape inside the action when a string is supplied.
    .option("--agent [handle]", "Authenticate this agent (with handle, or empty to pick interactively)")
    .addOption(clientIdOption())
    .addOption(clientSecretOption())
    .addOption(scopeOption())
    .option("--resource <url>", "Override the discovered websocket resource")
    .addOption(jsonOption())
    .action(async (opts: LoginOpts, cmd: Command) => {
      const config = await loadConfigFromRoot(cmd);

      // Validation: --client-id is meaningless without --agent.
      if (opts.clientId !== undefined && opts.agent === undefined) {
        throw new RobotNetCLIError(
          "--client-id only applies with --agent <handle>. " +
            "Client_credentials is always agent-scoped.",
        );
      }

      if (opts.agent === undefined) {
        // No --agent flag at all → user PKCE.
        await runUserLogin(config, opts);
        return;
      }

      // Resolve the handle from the flag value: explicit string, or open
      // the picker when --agent was passed without a value (commander
      // surfaces that as `true`).
      const handle = await resolveAgentHandle(config, opts);

      if (opts.clientId !== undefined) {
        const clientSecret = await resolveClientSecret(opts.clientSecret);
        const minted = await enrollAgentClientCredentials({
          config,
          handle,
          clientId: opts.clientId,
          clientSecret,
          ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
        });
        const payload: Record<string, unknown> = {
          signed_in_as: "agent",
          kind: "oauth_client_credentials",
          handle,
          network: config.network.name,
          expires_at: minted.bearerExpiresAt,
          scope: minted.scope,
        };
        if (opts.json) {
          console.log(renderJson(payload));
        } else {
          console.log(
            renderKeyValues(profileTitle("RobotNet Agent Login", config), payload),
          );
        }
        return;
      }

      // Agent PKCE — opens the browser for the user to authorize this
      // CLI to act as the agent. Same loopback-callback shape as user
      // PKCE, with `agent_handle` on the authorization URL.
      const minted = await enrollAgentPkce({
        config,
        handle,
        ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
      });
      const payload: Record<string, unknown> = {
        signed_in_as: "agent",
        kind: "oauth_pkce",
        handle,
        network: config.network.name,
        expires_at: minted.bearerExpiresAt,
        scope: minted.scope,
      };
      if (opts.json) {
        console.log(renderJson(payload));
      } else {
        console.log(
          renderKeyValues(profileTitle("RobotNet Agent Login", config), payload),
        );
      }
    });

  // login show
  // --agent lives on the parent `login` command; commander binds it there
  // when set, so we read via optsWithGlobals() to merge parent + own opts.
  login
    .command("show")
    .description("Show the current login state (user, or an agent with --agent)")
    .addOption(jsonOption())
    .action(async (_opts: ShowOpts, cmd: Command) => {
      const opts = cmd.optsWithGlobals() as ShowOpts;
      const config = await loadConfigFromRoot(cmd);

      if (opts.agent !== undefined) {
        const store = await openProcessCredentialStore(config);
        const row = store.getAgentCredential(config.network.name, opts.agent);
        if (row === null) {
          const message =
            `No credential stored for ${opts.agent} on network "${config.network.name}". ` +
            `Try: robotnet --network ${config.network.name} login --agent ${opts.agent}`;
          if (opts.json) {
            console.log(renderJson({ stored: false, agent: opts.agent }));
          } else {
            console.log(message);
          }
          return;
        }
        const payload: Record<string, unknown> = {
          stored: true,
          handle: row.handle,
          network: row.networkName,
          kind: row.kind,
          expires_at: row.bearerExpiresAt,
          scope: row.scope,
          registered_at: row.registeredAt,
          updated_at: row.updatedAt,
        };
        if (opts.json) {
          console.log(renderJson(payload));
        } else {
          console.log(
            renderKeyValues(profileTitle("RobotNet Agent Login", config), payload),
          );
        }
        return;
      }

      const store = await openProcessCredentialStore(config);
      const info = store.getUserSessionInfo();
      const payload: Record<string, unknown> = {
        configured: info !== null,
      };
      if (info) {
        payload.auth_mode = info.authMode;
        payload.client_id = info.clientId;
        payload.expires_at = info.accessTokenExpiresAt;
        payload.scope = info.scope;
        payload.token_endpoint = info.tokenEndpoint;
        payload.resource = info.resource;
      }
      if (opts.json) {
        console.log(renderJson(payload));
      } else {
        console.log(
          renderKeyValues(profileTitle("RobotNet Login Status", config), payload),
        );
      }
    });

  return login;
}

// ── logout ──────────────────────────────────────────────────────────────────

function makeLogoutCmd(): Command {
  return new Command("logout")
    .description(
      "Remove a stored credential. Without --agent: the user session. " +
        "With --agent: that agent's credential. With --all: every credential in this profile.",
    )
    .option(
      "--agent <handle>",
      "Remove this agent's credential instead of the user's",
      handleArg,
    )
    .option("--all", "Remove user session AND all agent credentials in this profile", false)
    .action(async (opts: LogoutOpts, cmd: Command) => {
      const config = await loadConfigFromRoot(cmd);

      if (opts.agent !== undefined && opts.all) {
        throw new RobotNetCLIError("--agent and --all are mutually exclusive");
      }

      if (opts.agent !== undefined) {
        const store = await openProcessCredentialStore(config);
        const removed = store.deleteAgentCredential(config.network.name, opts.agent);
        if (removed) {
          console.log(`Removed credential for ${opts.agent} on network "${config.network.name}".`);
        } else {
          console.log(`No credential stored for ${opts.agent} on network "${config.network.name}".`);
        }
        return;
      }

      const store = await openProcessCredentialStore(config);
      const removed = store.deleteUserSession();
      if (removed) {
        console.log("Signed out (user session cleared).");
      } else if (!opts.all) {
        console.log("Already signed out.");
        return;
      }

      if (opts.all) {
        // Drop every agent credential row in the active profile's store,
        // across every network the profile knows about.
        let totalRemoved = 0;
        for (const networkName of Object.keys(config.networks)) {
          const rows = store.listAgentCredentials(networkName);
          for (const row of rows) {
            if (store.deleteAgentCredential(row.networkName, row.handle)) {
              totalRemoved += 1;
            }
          }
        }
        console.log(
          totalRemoved === 0
            ? "(No agent credentials to remove.)"
            : `Removed ${totalRemoved} agent credential(s) across all networks in this profile.`,
        );
      }
    });
}

/* -------------------------------------------------------------------------- */
/* Login helpers                                                               */
/* -------------------------------------------------------------------------- */

async function runUserLogin(config: CLIConfig, opts: LoginOpts): Promise<void> {
  const discovery = await discoverOAuth(config.endpoints);
  const result = await performPkceLogin({
    endpoints: config.endpoints,
    discovery,
    ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
  });
  const accessTokenExpiresAt =
    result.token.expiresIn !== null
      ? Date.now() + result.token.expiresIn * 1000
      : null;
  const store = await openProcessCredentialStore(config);
  store.putUserSession({
    accessToken: result.token.accessToken,
    refreshToken: result.refreshToken,
    accessTokenExpiresAt,
    scope: result.token.scope,
    clientId: result.clientId,
    tokenEndpoint: result.tokenEndpoint,
    resource: result.token.resource,
    redirectUri: result.redirectUri,
    authMode: "pkce",
  });

  const payload: Record<string, unknown> = {
    signed_in_as: "user",
    client_id: result.clientId,
    expires_at: accessTokenExpiresAt,
    scope: result.token.scope,
  };
  if (opts.json) {
    console.log(renderJson(payload));
  } else {
    console.log(
      renderKeyValues(profileTitle("RobotNet Login", config), payload),
    );
  }
}

/**
 * Resolve the `--agent` flag's value into a concrete handle.
 *
 * - `--agent @x.y`: validate and return `@x.y`.
 * - `--agent` (no value, commander surfaces this as `true`): ensure the
 *   user has an active session, fetch their account's agents, and run
 *   the interactive picker. If no user session exists, drive user PKCE
 *   first so `login --agent` is a single end-to-end flow.
 */
async function resolveAgentHandle(
  config: CLIConfig,
  opts: LoginOpts,
): Promise<string> {
  if (typeof opts.agent === "string") {
    assertValidHandle(opts.agent);
    return opts.agent;
  }
  // opts.agent === true — the user passed `--agent` with no value.
  const store = await openProcessCredentialStore(config);
  const accessToken = await ensureUserAccessToken(store, config, opts);
  const agents = await fetchAccountAgents({ config, accessToken });
  return await pickAgent(agents);
}

/**
 * Return a usable user access token, running user PKCE first if no
 * session exists or the cached one is past expiry. We prefer surfacing
 * a fresh login over forcing the user to type a separate command.
 */
async function ensureUserAccessToken(
  store: CredentialStore,
  config: CLIConfig,
  opts: LoginOpts,
): Promise<string> {
  const existing = store.getUserSession();
  const stillValid =
    existing !== null &&
    (existing.accessTokenExpiresAt === null ||
      existing.accessTokenExpiresAt > Date.now() + 30_000);
  if (stillValid) {
    return (existing as NonNullable<typeof existing>).accessToken;
  }
  process.stderr.write(
    "No active user session — running user login first, then opening the agent picker.\n",
  );
  await runUserLogin(config, opts);
  const fresh = store.getUserSession();
  if (fresh === null) {
    throw new RobotNetCLIError(
      "internal: user session unexpectedly missing after login",
    );
  }
  return fresh.accessToken;
}

// ── option types ────────────────────────────────────────────────────────────

interface LoginOpts {
  /**
   * `string`: explicit handle (`--agent @x.y`).
   * `true`: flag passed with no value (`--agent`) → trigger picker.
   * `undefined`: flag absent → user login.
   */
  readonly agent?: string | true;
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly scope?: string;
  readonly resource?: string;
  readonly json?: boolean;
}

interface ShowOpts {
  readonly agent?: string;
  readonly json?: boolean;
}

interface LogoutOpts {
  readonly agent?: string;
  readonly all: boolean;
}
