import type { Command } from "commander";

import { DEFAULT_SCOPES } from "../auth/client-credentials.js";
import { resolveRuntimeSession } from "../auth/runtime.js";
import { loadConfig } from "../config.js";
import {
  loadStatus,
  readLogTail,
  resolveDaemonPaths,
  restartDaemon,
  startDaemon,
  stopDaemon,
} from "../daemon/manager.js";
import type { DaemonHealth, DaemonState } from "../daemon/state.js";
import {
  epochMillis,
  loadDaemonState,
  saveDaemonState,
} from "../daemon/state.js";
import { renderKeyValues } from "../output/formatters.js";
import { renderJson } from "../output/json-output.js";
import { listenForever } from "../realtime/listener.js";
import {
  clientIdOption,
  clientSecretOption,
  jsonOption,
  parsePositiveInt,
  profileTitle,
  resolveCredentials,
  scopeOption,
} from "./shared.js";

function coerceHealth(value: string): DaemonHealth {
  if (
    value === "starting" ||
    value === "connected" ||
    value === "reconnecting" ||
    value === "stopped"
  ) {
    return value;
  }
  return "reconnecting";
}

function daemonStatusPayload(
  state: DaemonState | null,
  logFile: string,
): Record<string, unknown> {
  if (!state) {
    return { running: false, health: "stopped", log_file: logFile };
  }
  return {
    running: state.pid !== null,
    pid: state.pid,
    health: state.health,
    client_id: state.clientId,
    agent_ref: state.agentRef,
    websocket_url: state.websocketUrl,
    last_event_at: state.lastEventAt,
    last_error: state.lastError,
    updated_at: state.updatedAt,
    log_file: state.logFile,
  };
}

export function registerDaemonCommand(program: Command): void {
  const daemonCmd = program
    .command("daemon")
    .description("Manage the background websocket listener");

  daemonCmd
    .command("start")
    .description("Start the background listener")
    .addOption(clientIdOption())
    .addOption(clientSecretOption())
    .addOption(scopeOption())
    .addOption(jsonOption())
    .action(async (opts, cmd) => {
      const config = loadConfig(cmd.parent?.parent?.opts().profile);
      const { clientId, clientSecret } = await resolveCredentials(config, opts);
      const { pid, paths } = startDaemon({
        config,
        clientId,
        clientSecret,
        scope: opts.scope,
      });
      const payload = {
        started: true,
        pid,
        state_file: paths.stateFile,
        log_file: paths.logFile,
      };
      if (opts.json) {
        console.log(renderJson(payload));
      } else {
        console.log(
          renderKeyValues(
            profileTitle("RoboNet Daemon Started", config),
            payload,
          ),
        );
      }
    });

  daemonCmd
    .command("stop")
    .description("Stop the background listener")
    .addOption(jsonOption())
    .action(async (opts, cmd) => {
      const config = loadConfig(cmd.parent?.parent?.opts().profile);
      const state = stopDaemon({ config });
      const payload: Record<string, unknown> = { stopped: state !== null };
      if (state) payload.log_file = state.logFile;
      if (opts.json) {
        console.log(renderJson(payload));
      } else {
        console.log(
          renderKeyValues(
            profileTitle("RoboNet Daemon Stopped", config),
            payload,
          ),
        );
      }
    });

  daemonCmd
    .command("restart")
    .description("Restart the background listener")
    .addOption(clientIdOption())
    .addOption(clientSecretOption())
    .addOption(scopeOption())
    .addOption(jsonOption())
    .action(async (opts, cmd) => {
      const config = loadConfig(cmd.parent?.parent?.opts().profile);
      const { clientId, clientSecret } = await resolveCredentials(config, opts);
      const { pid, paths } = restartDaemon({
        config,
        clientId,
        clientSecret,
        scope: opts.scope,
      });
      const payload = {
        restarted: true,
        pid,
        state_file: paths.stateFile,
        log_file: paths.logFile,
      };
      if (opts.json) {
        console.log(renderJson(payload));
      } else {
        console.log(
          renderKeyValues(
            profileTitle("RoboNet Daemon Restarted", config),
            payload,
          ),
        );
      }
    });

  daemonCmd
    .command("status")
    .description("Show daemon status")
    .addOption(jsonOption())
    .action(async (opts, cmd) => {
      const config = loadConfig(cmd.parent?.parent?.opts().profile);
      const state = loadStatus(config);
      const payload = daemonStatusPayload(
        state,
        resolveDaemonPaths(config).logFile,
      );
      if (opts.json) {
        console.log(renderJson(payload));
      } else {
        console.log(
          renderKeyValues(
            profileTitle("RoboNet Daemon Status", config),
            payload,
          ),
        );
      }
    });

  daemonCmd
    .command("logs")
    .description("Show recent daemon logs")
    .option("--lines <n>", "Number of lines to show", "50")
    .action(async (opts, cmd) => {
      const config = loadConfig(cmd.parent?.parent?.opts().profile);
      const paths = resolveDaemonPaths(config);
      for (const line of readLogTail(paths.logFile, parsePositiveInt(opts.lines, 50))) {
        console.log(line);
      }
    });

  daemonCmd
    .command("run-listener", { hidden: true })
    .addOption(clientIdOption())
    .addOption(clientSecretOption())
    .addOption(scopeOption())
    .action(async (opts, cmd) => {
      const config = loadConfig(cmd.parent?.parent?.opts().profile);
      const paths = resolveDaemonPaths(config);
      const stateFile = paths.stateFile;

      function updateState(
        health: string,
        agentRefValue: string | null,
        lastError: string | null,
        lastEventAt: number | null,
      ): void {
        const existing = loadDaemonState(stateFile);
        const currentAgentRef =
          agentRefValue ?? existing?.agentRef ?? null;
        const currentLastError =
          lastError !== null ? lastError : (existing?.lastError ?? null);
        const currentLastEventAt =
          lastEventAt !== null ? lastEventAt : (existing?.lastEventAt ?? null);

        saveDaemonState(stateFile, {
          pid: process.pid,
          health: coerceHealth(health),
          websocketUrl: config.endpoints.websocketUrl,
          clientId: opts.clientId ?? "",
          agentRef: currentAgentRef,
          lastEventAt: currentLastEventAt,
          lastError: currentLastError,
          updatedAt: epochMillis(),
          logFile: paths.logFile,
        });
      }

      process.on("SIGTERM", () => {
        updateState("stopped", null, null, null);
        process.exit(0);
      });

      updateState("starting", null, null, null);
      await listenForever({
        sessionFactory: () =>
          resolveRuntimeSession({
            endpoints: config.endpoints,
            tokenStorePath: config.tokenStoreFile,
            clientId: opts.clientId ?? null,
            clientSecret: opts.clientSecret ?? process.env.ROBONET_CLIENT_SECRET ?? null,
            scope: opts.scope,
          }),
        logger: (message) => console.log(message),
        stateCallback: updateState,
      });
    });
}

export function registerListenCommand(program: Command): void {
  program
    .command("listen")
    .description("Run a foreground websocket listener")
    .addOption(clientIdOption())
    .addOption(clientSecretOption())
    .addOption(scopeOption())
    .option("-v, --verbose", "Log connection-keepalive heartbeats (ping/pong)")
    .action(async (opts, cmd) => {
      const config = loadConfig(cmd.parent?.opts().profile);
      const { clientId, clientSecret } = await resolveCredentials(config, opts);
      await listenForever({
        sessionFactory: () =>
          resolveRuntimeSession({
            endpoints: config.endpoints,
            tokenStorePath: config.tokenStoreFile,
            clientId,
            clientSecret,
            scope: opts.scope,
          }),
        logger: (message) => console.log(message),
        verbose: Boolean(opts.verbose),
      });
    });
}
