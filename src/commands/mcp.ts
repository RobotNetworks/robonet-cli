import type { Command } from "commander";

import { loadConfig } from "../config.js";
import { RoboNetCLIError } from "../errors.js";
import { renderJson } from "../output/json-output.js";
import {
  buildAuthenticatedMcpClient,
  jsonOption,
  profileTitle,
} from "./shared.js";

export function registerMcpCommand(program: Command): void {
  const mcpCmd = program
    .command("mcp")
    .description("Access the full MCP tool surface directly");

  mcpCmd
    .command("tools")
    .description("List MCP tools exposed by the RoboNet server")
    .addOption(jsonOption())
    .action(async (opts, cmd) => {
      const config = loadConfig(cmd.parent?.parent?.opts().profile);
      const client = await buildAuthenticatedMcpClient(config);
      const tools = await client.listTools();

      const payload = { tools };
      if (opts.json) {
        console.log(renderJson(payload));
        return;
      }
      console.log(profileTitle(`MCP Tools (${tools.length})`, config));
      for (const tool of tools) {
        console.log(`- ${tool.name ?? "unknown"}: ${tool.description ?? ""}`);
      }
    });

  mcpCmd
    .command("call")
    .description("Call an MCP tool by name with JSON arguments")
    .argument("<tool_name>")
    .option("--args-json <json>", "JSON object of tool arguments", "{}")
    .addOption(jsonOption())
    .action(async (toolName, opts, cmd) => {
      const config = loadConfig(cmd.parent?.parent?.opts().profile);
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(opts.argsJson) as Record<string, unknown>;
      } catch (err) {
        throw new RoboNetCLIError(`Invalid --args-json value: ${err}`);
      }
      if (typeof args !== "object" || args === null || Array.isArray(args)) {
        throw new RoboNetCLIError("--args-json must decode to a JSON object.");
      }

      const client = await buildAuthenticatedMcpClient(config);
      const payload = await client.callTool(toolName, args);

      if (opts.json) {
        console.log(renderJson(payload));
        return;
      }
      console.log(profileTitle(`MCP Tool Result: ${toolName}`, config));
      console.log(renderJson(payload));
    });
}
