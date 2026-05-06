import { Command } from "commander";

import { discoverOAuth } from "../auth/discovery.js";
import { performPkceLogin } from "../auth/pkce.js";
import {
  enrollAgentClientCredentials,
  enrollAgentPkce,
  enrollAgentPkceViaPicker,
} from "../asp/agent-login.js";
import { assertValidHandle, handleArg } from "../asp/handles.js";
import type { CLIConfig } from "../config.js";
import { openProcessCredentialStore } from "../credentials/lifecycle.js";
import { loadConfigFromRoot } from "./asp-shared.js";
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

      assertNetworkSupportsOAuthLogin(config, opts.agent);

      // Validation: --client-id is meaningless without --agent.
      if (opts.clientId !== undefined && opts.agent === undefined) {
        throw new RobotNetCLIError(
          "--client-id only applies with --agent <handle>. " +
            "Client_credentials is always agent-scoped.",
        );
      }
      // Validation: --client-id with picker mode would need a handle that
      // doesn't exist yet. The web picker isn't reachable from the
      // client-credentials grant anyway. Reject early.
      if (opts.clientId !== undefined && opts.agent === true) {
        throw new RobotNetCLIError(
          "--client-id requires --agent <handle>. The web picker only applies to PKCE.",
        );
      }

      if (opts.agent === undefined) {
        // No --agent flag at all → user PKCE.
        await runUserLogin(config, opts);
        return;
      }

      if (opts.clientId !== undefined) {
        // commander gives us `string` for `--agent <handle>` after the
        // earlier guard ruled out the bare `--agent` shape.
        const handle = opts.agent as string;
        assertValidHandle(handle);
        const clientSecret = await resolveClientSecret(opts.clientSecret);
        const minted = await enrollAgentClientCredentials({
          config,
          handle,
          clientId: opts.clientId,
          clientSecret,
          ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
        });
        printAgentLoginResult(opts, config, {
          kind: "oauth_client_credentials",
          handle,
          expiresAt: minted.bearerExpiresAt,
          scope: minted.scope,
        });
        return;
      }

      // Agent PKCE. Two shapes:
      //   - explicit handle (`--agent @x.y`): confirm-mode in the web.
      //   - bare `--agent`: web picker, handle resolved from token response.
      const enrolled =
        typeof opts.agent === "string"
          ? await (async () => {
              assertValidHandle(opts.agent as string);
              return await enrollAgentPkce({
                config,
                handle: opts.agent as string,
                ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
              });
            })()
          : await enrollAgentPkceViaPicker({
              config,
              ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
            });

      printAgentLoginResult(opts, config, {
        kind: "oauth_pkce",
        handle: enrolled.handle,
        expiresAt: enrolled.bearerExpiresAt,
        scope: enrolled.scope,
      });
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

/**
 * Refuse `login` against networks that don't speak OAuth.
 *
 * `agent-token` networks (e.g. a local `robotnet network start` instance)
 * have no PKCE flow at all; running `login` against one would silently
 * dial whichever auth server the profile's `endpoints` happen to point
 * at and persist a credential under the wrong network key. The
 * canonical failure: cwd resolves the network to `local` but endpoints
 * still default to `https://auth.robotnet.ai`, so the human signs in
 * to the public auth server, gets a real token, and the row lands keyed
 * on `("local", "<handle>")` — invisible to anything querying by
 * `("public", "<handle>")` afterwards.
 *
 * Exported so the guard can be tested in isolation from the commander
 * action wrapper.
 */
export function assertNetworkSupportsOAuthLogin(
  config: CLIConfig,
  agent: string | true | undefined,
): void {
  if (config.network.authMode === "oauth") return;

  const oauthNetworks = Object.values(config.networks)
    .filter((n) => n.authMode === "oauth")
    .map((n) => n.name);
  const agentSuffix =
    typeof agent === "string"
      ? ` --agent ${agent}`
      : agent === true
        ? " --agent"
        : "";
  const suggestion =
    oauthNetworks.length === 1
      ? ` Try: robotnet --network ${oauthNetworks[0]} login${agentSuffix}`
      : oauthNetworks.length > 1
        ? ` Available OAuth networks: ${oauthNetworks.join(", ")}.`
        : "";
  throw new RobotNetCLIError(
    `\`login\` requires an OAuth network, but the resolved network "${config.network.name}" uses ${config.network.authMode} auth.${suggestion}`,
  );
}

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
 * Render the success output for an agent-mode login (PKCE or
 * client_credentials), preserving the shape `login` has emitted since
 * v0.3 so plugins parsing `--json` don't drift.
 */
function printAgentLoginResult(
  opts: LoginOpts,
  config: CLIConfig,
  args: {
    kind: "oauth_pkce" | "oauth_client_credentials";
    handle: string;
    expiresAt: number | null;
    scope: string | null;
  },
): void {
  const payload: Record<string, unknown> = {
    signed_in_as: "agent",
    kind: args.kind,
    handle: args.handle,
    network: config.network.name,
    expires_at: args.expiresAt,
    scope: args.scope,
  };
  if (opts.json) {
    console.log(renderJson(payload));
  } else {
    console.log(
      renderKeyValues(profileTitle("RobotNet Agent Login", config), payload),
    );
  }
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
