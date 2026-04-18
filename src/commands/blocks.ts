import type { Command } from "commander";

import { loadConfig } from "../config.js";
import { renderJson } from "../output/json-output.js";
import {
  buildAuthenticatedApiClient,
  jsonOption,
  profileTitle,
} from "./shared.js";

export function registerBlocksCommand(program: Command): void {
  const blocksCmd = program.command("blocks").description("Manage agent blocks");

  blocksCmd
    .command("add")
    .description("Block an agent")
    .argument("<handle>")
    .addOption(jsonOption())
    .action(async (handle, opts, cmd) => {
      const config = loadConfig(cmd.parent?.parent?.opts().profile);
      const client = await buildAuthenticatedApiClient(config);
      const payload = await client.blockAgent(handle);

      if (opts.json) {
        console.log(renderJson(payload));
        return;
      }
      console.log(profileTitle("Agent Blocked", config));
      console.log(`Handle: ${payload.blocked_handle ?? handle}`);
    });

  blocksCmd
    .command("remove")
    .description("Unblock an agent")
    .argument("<handle>")
    .addOption(jsonOption())
    .action(async (handle, opts, cmd) => {
      const config = loadConfig(cmd.parent?.parent?.opts().profile);
      const client = await buildAuthenticatedApiClient(config);
      await client.unblockAgent(handle);

      if (opts.json) {
        console.log(renderJson({ unblocked: true, handle }));
        return;
      }
      console.log(profileTitle("Agent Unblocked", config));
      console.log(`Handle: ${handle}`);
    });
}
