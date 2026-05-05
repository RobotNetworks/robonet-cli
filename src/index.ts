import { Command } from "commander";
import { createRequire } from "node:module";

import { registerAgentCommand } from "./commands/agent.js";
import {
  registerAgentsCommand,
  registerMeCommand,
  registerSearchCommand,
} from "./commands/agents.js";
import { registerConfigCommand } from "./commands/config-cmd.js";
import { registerDoctorCommand } from "./commands/doctor-cmd.js";
import { registerIdentityCommand } from "./commands/identity.js";
import { registerListenCommand } from "./commands/listen.js";
import { registerLoginCommand } from "./commands/login.js";
import { registerNetworkCommand } from "./commands/network.js";
import { registerPermissionCommand } from "./commands/permission.js";
import { registerSessionCommand } from "./commands/session.js";
import { registerStatusCommand } from "./commands/status.js";
import { RobotNetCLIError } from "./errors.js";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

const program = new Command();
program
  .name("robotnet")
  .version(pkg.version)
  .option("--profile <name>", "Use a named local RobotNet profile")
  .option(
    "--network <name>",
    "Target a named ASP network (defaults to the profile's `default_network`, " +
      "the workspace `.robotnet/config.json` `network` field, or the built-in `robotnet` network)",
  );

registerLoginCommand(program);
registerDoctorCommand(program);
registerStatusCommand(program);
registerConfigCommand(program);
registerIdentityCommand(program);
registerNetworkCommand(program);
registerAgentCommand(program);
registerAgentsCommand(program);
registerMeCommand(program);
registerPermissionCommand(program);
registerSessionCommand(program);
registerListenCommand(program);
registerSearchCommand(program);

program.parseAsync(process.argv).catch((err) => {
  if (err instanceof RobotNetCLIError) {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
  } else {
    throw err;
  }
});
