import type { Command } from "commander";

import { runDoctor } from "../doctor.js";
import { renderJson } from "../output/json-output.js";
import { loadConfigFromRoot } from "./asp-shared.js";
import { jsonOption, profileTitle } from "./shared.js";

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Run local Robot Networks CLI diagnostics")
    .addOption(jsonOption())
    .action(async (opts, cmd) => {
      const config = await loadConfigFromRoot(cmd);
      const checks = await runDoctor(config);
      const ok = checks.every((c) => c.ok);
      const payload = { ok, checks };

      if (opts.json) {
        console.log(renderJson(payload));
        process.exitCode = ok ? 0 : 1;
        return;
      }
      console.log(profileTitle("Robot Networks Doctor", config));
      for (const check of checks) {
        const status = check.ok ? "ok" : "fail";
        console.log(`- ${check.name}: ${status} - ${check.detail}`);
      }
      process.exitCode = ok ? 0 : 1;
    });
}
