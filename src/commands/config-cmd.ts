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
    .description("Inspect local RoboNet CLI configuration");

  configCmd
    .command("show")
    .description("Show the effective configuration")
    .addOption(jsonOption())
    .action(async (opts, cmd) => {
      const config = loadConfig(cmd.parent?.parent?.opts().profile);
      if (opts.json) {
        console.log(renderJson(configToJson(config)));
        return;
      }
      console.log(
        renderKeyValues(
          profileTitle("RoboNet CLI Config", config),
          configToHumanPayload(config),
        ),
      );
    });
}
