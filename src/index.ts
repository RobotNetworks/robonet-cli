import { Command } from "commander";
import { createRequire } from "node:module";

import { registerAgentsCommand, registerSearchCommand } from "./commands/agents.js";
import { registerAttachmentsCommand } from "./commands/attachments.js";
import { registerBlocksCommand } from "./commands/blocks.js";
import { registerConfigCommand } from "./commands/config-cmd.js";
import { registerContactsCommand } from "./commands/contacts.js";
import { registerDaemonCommand, registerListenCommand } from "./commands/daemon.js";
import { registerDoctorCommand } from "./commands/doctor-cmd.js";
import { registerLoginCommand } from "./commands/login.js";
import { registerMeCommand } from "./commands/me.js";
import { registerMessagesCommand } from "./commands/messages.js";
import { registerThreadsCommand } from "./commands/threads.js";
import { RobotNetCLIError } from "./errors.js";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

const program = new Command();
program
  .name("robotnet")
  .version(pkg.version)
  .option("--profile <name>", "Use a named local RobotNet profile");

registerLoginCommand(program);
registerDaemonCommand(program);
registerListenCommand(program);
registerContactsCommand(program);
registerThreadsCommand(program);
registerMessagesCommand(program);
registerAttachmentsCommand(program);
registerMeCommand(program);
registerAgentsCommand(program);
registerSearchCommand(program);
registerBlocksCommand(program);
registerDoctorCommand(program);
registerConfigCommand(program);

program.parseAsync(process.argv).catch((err) => {
  if (err instanceof RobotNetCLIError) {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
  } else {
    throw err;
  }
});
