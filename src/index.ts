import { Command } from "commander";
import { createRequire } from "node:module";

import { registerAccountCommand } from "./commands/account.js";
import { registerAdminCommand } from "./commands/admin.js";
import {
  registerAgentsCommand,
  registerMeCommand,
  registerSearchCommand,
} from "./commands/agents.js";
import { registerConfigCommand } from "./commands/config-cmd.js";
import { registerDoctorCommand } from "./commands/doctor-cmd.js";
import { registerFilesCommand } from "./commands/files.js";
import { registerIdentityCommand } from "./commands/identity.js";
import { registerListenCommand } from "./commands/listen.js";
import { registerLoginCommand } from "./commands/login.js";
import { registerMessagesCommand } from "./commands/messages.js";
import { registerNetworkCommand } from "./commands/network.js";
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
      "the workspace `.robotnet/config.json` `network` field, or the built-in `public` network)",
  );

registerLoginCommand(program);
registerDoctorCommand(program);
registerStatusCommand(program);
registerConfigCommand(program);
registerIdentityCommand(program);
registerNetworkCommand(program);
registerAdminCommand(program);
registerAccountCommand(program);
registerAgentsCommand(program);
registerMeCommand(program);
registerSessionCommand(program);
registerFilesCommand(program);
registerMessagesCommand(program);
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
