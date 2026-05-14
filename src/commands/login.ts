import { Command } from "commander";

import {
  enrollAgentClientCredentials,
  enrollAgentPkce,
  enrollAgentPkceViaPicker,
} from "../asmtp/agent-login.js";
import { assertValidHandle, handleArg } from "../asmtp/handles.js";
import type { CLIConfig } from "../config.js";
import { openProcessCredentialStore } from "../credentials/lifecycle.js";
import { RobotNetCLIError } from "../errors.js";
import { renderKeyValues } from "../output/formatters.js";
import { renderJson } from "../output/json-output.js";
import {
  clientIdOption,
  clientSecretOption,
  jsonOption,
  loadConfigForAgentCommand,
  loadConfigFromRoot,
  profileTitle,
  resolveClientSecret,
  scopeOption,
} from "./shared.js";

/**
 * `robotnet login` and `robotnet logout` — agent-credential bootstrap.
 *
 * Under the actor model, "login" without further qualification is the
 * common path of "authenticate as an agent": either pick one in the web
 * (no flag) or specify a handle (`--agent @x.y`). The user-account-side
 * authentication lives at `robotnet account login` (see commands/account.ts).
 *
 * Agent credentials are stored in the SQLite credential store keyed by
 * `(network, handle)` and surface to every agent-bearer command (`me`,
 * `agents`, `session`, `listen`, `messages`).
 */
export function registerLoginCommand(program: Command): void {
  program.addCommand(makeLoginCmd());
  program.addCommand(makeLogoutCmd());
}

// ── login ───────────────────────────────────────────────────────────────────

function makeLoginCmd(): Command {
  const login = new Command("login")
    .description(
      "Authenticate as an agent. Without --agent: a web picker chooses the agent " +
        "from those owned by the calling account. With --agent <handle>: PKCE for " +
        "that specific agent (or client_credentials when --client-id/--client-secret " +
        "are supplied).",
    )
    .option("--agent <handle>", "Authenticate this agent handle (skips the picker)")
    .addOption(clientIdOption())
    .addOption(clientSecretOption())
    .addOption(scopeOption())
    .option("--resource <url>", "Override the discovered websocket resource")
    .addOption(jsonOption())
    .action(async (opts: LoginOpts, cmd: Command) => {
      const config = await loadConfigFromRoot(cmd);
      assertNetworkSupportsOAuthLogin(config);

      // Validation: --client-id requires an explicit --agent because the web
      // picker only applies to PKCE; client_credentials is always for a
      // specific known handle.
      if (opts.clientId !== undefined && opts.agent === undefined) {
        throw new RobotNetCLIError(
          "--client-id requires --agent <handle>. The web picker only applies to PKCE.",
        );
      }

      if (opts.agent !== undefined && opts.clientId !== undefined) {
        assertValidHandle(opts.agent);
        const clientSecret = await resolveClientSecret(opts.clientSecret);
        const minted = await enrollAgentClientCredentials({
          config,
          handle: opts.agent,
          clientId: opts.clientId,
          clientSecret,
          ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
        });
        printAgentLoginResult(opts, config, {
          kind: "oauth_client_credentials",
          handle: opts.agent,
          expiresAt: minted.bearerExpiresAt,
          scope: minted.scope,
        });
        return;
      }

      // PKCE. Two shapes:
      //   - explicit handle (`--agent @x.y`): confirm-mode in the web picker.
      //   - no handle: web picker chooses, handle returned in the token response.
      const enrolled =
        opts.agent !== undefined
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
  // --agent and --as both flow through commander's parent merging.
  login
    .command("show")
    .description("Show the credential state for an agent (defaults to the active agent)")
    .option("--agent <handle>", "Show this agent's credential", handleArg)
    .option("--as <handle>", "Resolve the active agent via this handle", handleArg)
    .addOption(jsonOption())
    .action(async (_opts: ShowOpts, cmd: Command) => {
      const opts = cmd.optsWithGlobals() as ShowOpts;
      // Determine which agent's credential to inspect: explicit --agent,
      // else the active agent resolved via --as / env / identity file.
      const handle =
        opts.agent ??
        (await loadConfigForAgentCommand(cmd, opts.as)).identity.handle;
      const config = await loadConfigFromRoot(cmd);
      const store = await openProcessCredentialStore(config);
      const row = store.getAgentCredential(config.network.name, handle);
      if (row === null) {
        const message =
          `No credential stored for ${handle} on network "${config.network.name}". ` +
          `Try: robotnet login --agent ${handle} --network ${config.network.name}`;
        if (opts.json) {
          out(renderJson({ stored: false, agent: handle }));
        } else {
          out(message);
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
        out(renderJson(payload));
        return;
      }
      out(renderKeyValues(profileTitle("Agent login", config), payload));
    });

  return login;
}

// ── logout ──────────────────────────────────────────────────────────────────

function makeLogoutCmd(): Command {
  return new Command("logout")
    .description(
      "Remove a stored agent credential. Without flags: the active agent. " +
        "With --agent: that handle. With --all: every agent credential in this profile.",
    )
    .option(
      "--agent <handle>",
      "Remove this agent's credential",
      handleArg,
    )
    .option("--as <handle>", "Resolve the active agent via this handle", handleArg)
    .option("--all", "Remove every agent credential across every network in this profile", false)
    .action(async (opts: LogoutOpts, cmd: Command) => {
      const config = await loadConfigFromRoot(cmd);

      if (opts.agent !== undefined && opts.all) {
        throw new RobotNetCLIError("--agent and --all are mutually exclusive");
      }

      if (opts.all) {
        let totalRemoved = 0;
        const store = await openProcessCredentialStore(config);
        for (const networkName of Object.keys(config.networks)) {
          const rows = store.listAgentCredentials(networkName);
          for (const row of rows) {
            if (store.deleteAgentCredential(row.networkName, row.handle)) {
              totalRemoved += 1;
            }
          }
        }
        out(
          totalRemoved === 0
            ? "(No agent credentials to remove.)"
            : `Removed ${totalRemoved} agent credential(s) across all networks in this profile.`,
        );
        return;
      }

      const handle =
        opts.agent ??
        (await loadConfigForAgentCommand(cmd, opts.as)).identity.handle;
      const store = await openProcessCredentialStore(config);
      const removed = store.deleteAgentCredential(config.network.name, handle);
      if (removed) {
        out(`Removed credential for ${handle} on network "${config.network.name}".`);
      } else {
        out(`No credential stored for ${handle} on network "${config.network.name}".`);
      }
    });
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Refuse `login` against networks that don't speak OAuth.
 *
 * `agent-token` networks (e.g. a local `robotnet network start` instance)
 * have no PKCE flow; the corresponding ceremony for minting an agent
 * bearer there is `robotnet admin agent create`. Surface a clear error
 * rather than letting the command fall through to whichever auth server
 * the profile's `endpoints` happen to point at.
 *
 * Exported so the guard can be tested in isolation from the commander
 * action wrapper.
 */
export function assertNetworkSupportsOAuthLogin(config: CLIConfig): void {
  if (config.network.authMode === "oauth") return;

  const oauthNetworks = Object.values(config.networks)
    .filter((n) => n.authMode === "oauth")
    .map((n) => n.name);
  const suggestion =
    oauthNetworks.length === 1
      ? ` Try: robotnet login --network ${oauthNetworks[0]}`
      : oauthNetworks.length > 1
        ? ` Available OAuth networks: ${oauthNetworks.join(", ")}.`
        : "";
  throw new RobotNetCLIError(
    `\`login\` requires an OAuth network, but the resolved network "${config.network.name}" uses ${config.network.authMode} auth. ` +
      `For local networks, mint an agent bearer with \`robotnet admin agent create <handle>\` instead.${suggestion}`,
  );
}

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
    out(renderJson(payload));
  } else {
    out(renderKeyValues(profileTitle("Agent login", config), payload));
  }
}

function out(line: string): void {
  console.log(line);
}

// ── option types ────────────────────────────────────────────────────────────

interface LoginOpts {
  readonly agent?: string;
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly scope?: string;
  readonly resource?: string;
  readonly json?: boolean;
}

interface ShowOpts {
  readonly agent?: string;
  readonly as?: string;
  readonly json?: boolean;
}

interface LogoutOpts {
  readonly agent?: string;
  readonly as?: string;
  readonly all: boolean;
}
