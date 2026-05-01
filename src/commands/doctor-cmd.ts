import type { Command } from "commander";

import { loadConfig } from "../config.js";
import { runDoctor } from "../doctor.js";
import { renderJson } from "../output/json-output.js";
import { jsonOption, profileTitle } from "./shared.js";

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Run local RobotNet CLI diagnostics")
    .addOption(jsonOption())
    .action(async (opts, cmd) => {
      const config = loadConfig(cmd.parent?.opts().profile);
      const checks = await runDoctor(config);
      const ok = checks.every((c) => c.ok);
      const payload = { ok, checks };

      if (opts.json) {
        console.log(renderJson(payload));
        process.exitCode = ok ? 0 : 1;
        return;
      }
      console.log(profileTitle("RobotNet Doctor", config));
      for (const check of checks) {
        const status = check.ok ? "ok" : "fail";
        console.log(`- ${check.name}: ${status} - ${check.detail}`);
      }
      process.exitCode = ok ? 0 : 1;
    });
}
