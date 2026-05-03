import type { Command } from "commander";

import {
  loadConfig,
  configToJson,
  configToHumanPayload,
} from "../config.js";
import { renderKeyValues } from "../output/formatters.js";
import { renderJson } from "../output/json-output.js";
import { jsonOption, profileTitle } from "./shared.js";

export function registerConfigCommand(program: Command): void {
  const configCmd = program
    .command("config")
    .description("Inspect local RobotNet CLI configuration");

  configCmd
    .command("show")
    .description("Show the effective configuration")
    .addOption(jsonOption())
    .action(async (opts, cmd) => {
      const rootOpts = cmd.parent?.parent?.opts() ?? {};
      const config = loadConfig(rootOpts.profile, {
        networkName: rootOpts.network,
      });
      if (opts.json) {
        console.log(renderJson(configToJson(config)));
        return;
      }
      console.log(
        renderKeyValues(
          profileTitle("RobotNet CLI Config", config),
          configToHumanPayload(config),
        ),
      );
    });
}
