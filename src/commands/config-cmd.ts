import type { Command } from "commander";

import { configToJson, configToHumanPayload } from "../config.js";
import { renderKeyValues } from "../output/formatters.js";
import { renderJson } from "../output/json-output.js";
import { jsonOption, loadConfigFromRoot, profileTitle } from "./shared.js";

export function registerConfigCommand(program: Command): void {
  const configCmd = program
    .command("config")
    .description("Inspect local Robot Networks CLI configuration");

  configCmd
    .command("show")
    .description("Show the effective configuration")
    .addOption(jsonOption())
    .action(async (opts, cmd) => {
      const config = await loadConfigFromRoot(cmd);
      if (opts.json) {
        console.log(renderJson(configToJson(config)));
        return;
      }
      console.log(
        renderKeyValues(
          profileTitle("Robot Networks CLI Config", config),
          configToHumanPayload(config),
        ),
      );
    });
}
