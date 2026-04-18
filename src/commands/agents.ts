import type { Command } from "commander";

import { loadConfig } from "../config.js";
import { renderJson } from "../output/json-output.js";
import {
  buildAuthenticatedApiClient,
  jsonOption,
  parsePositiveInt,
  profileTitle,
} from "./shared.js";

export function registerAgentsCommand(program: Command): void {
  const agentsCmd = program
    .command("agents")
    .description("Inspect agents by handle");

  agentsCmd
    .command("show")
    .description("Show an agent profile by handle")
    .argument("<handle>")
    .addOption(jsonOption())
    .action(async (handle, opts, cmd) => {
      const config = loadConfig(cmd.parent?.parent?.opts().profile);
      const client = await buildAuthenticatedApiClient(config);
      const payload = await client.getAgentByHandle(handle);

      if (opts.json) {
        console.log(renderJson(payload));
        return;
      }
      const agent =
        typeof payload.agent === "object" && payload.agent !== null
          ? (payload.agent as Record<string, unknown>)
          : payload;
      console.log(profileTitle(`Agent ${handle}`, config));
      console.log(`Handle: ${agent.canonical_handle ?? handle}`);
      console.log(`Display Name: ${agent.display_name ?? ""}`);
      if (typeof agent.description === "string" && agent.description) {
        console.log(`Description: ${agent.description}`);
      }
      const viewer =
        typeof payload.viewer === "object" && payload.viewer !== null
          ? (payload.viewer as Record<string, unknown>)
          : null;
      if (viewer && typeof viewer.relationship === "string") {
        console.log(`Relationship: ${viewer.relationship}`);
      }
    });

  agentsCmd
    .command("card")
    .description("Get an agent's card by handle")
    .argument("<handle>")
    .addOption(jsonOption())
    .action(async (handle, opts, cmd) => {
      const config = loadConfig(cmd.parent?.parent?.opts().profile);
      const client = await buildAuthenticatedApiClient(config);
      const card = await client.getAgentCard(handle);
      if (opts.json) {
        console.log(renderJson({ handle, card }));
        return;
      }
      console.log(card);
    });

  agentsCmd
    .command("search")
    .description("Search for agents visible to the current agent")
    .requiredOption("--query <text>", "Search query")
    .option("--limit <n>", "Maximum results", "20")
    .addOption(jsonOption())
    .action(async (opts, cmd) => {
      const config = loadConfig(cmd.parent?.parent?.opts().profile);
      const client = await buildAuthenticatedApiClient(config);
      const payload = await client.searchAgents({
        queryText: opts.query,
        limit: parsePositiveInt(opts.limit, 20),
      });

      if (opts.json) {
        console.log(renderJson(payload));
        return;
      }
      const agents = Array.isArray(payload.agents) ? payload.agents : [];
      console.log(profileTitle(`Agent Search (${agents.length})`, config));
      for (const item of agents) {
        if (typeof item !== "object" || item === null) continue;
        const agent = item as Record<string, unknown>;
        console.log(
          `- ${agent.canonical_handle ?? "unknown"} | ${agent.display_name ?? ""}`,
        );
      }
    });
}

export function registerSearchCommand(program: Command): void {
  program
    .command("search")
    .description("Search directory entities visible to the current agent")
    .requiredOption("--query <text>", "Search query")
    .option("--limit <n>", "Maximum results per section", "20")
    .addOption(jsonOption())
    .action(async (opts, cmd) => {
      const config = loadConfig(cmd.parent?.opts().profile);
      const client = await buildAuthenticatedApiClient(config);
      const payload = await client.searchDirectory({
        queryText: opts.query,
        limit: parsePositiveInt(opts.limit, 20),
      });

      if (opts.json) {
        console.log(renderJson(payload));
        return;
      }

      const agents = Array.isArray(payload.agents) ? payload.agents : [];
      const people = Array.isArray(payload.people) ? payload.people : [];
      const organizations = Array.isArray(payload.organizations)
        ? payload.organizations
        : [];

      console.log(profileTitle("Directory Search", config));
      if (agents.length > 0) {
        console.log("Agents:");
        for (const item of agents) {
          if (typeof item !== "object" || item === null) continue;
          const agent = item as Record<string, unknown>;
          console.log(
            `- ${agent.canonical_handle ?? "unknown"} | ${agent.display_name ?? ""}`,
          );
        }
      }
      if (people.length > 0) {
        console.log("People:");
        for (const item of people) {
          if (typeof item !== "object" || item === null) continue;
          const person = item as Record<string, unknown>;
          console.log(`- ${person.username ?? "unknown"} | ${person.display_name ?? ""}`);
        }
      }
      if (organizations.length > 0) {
        console.log("Organizations:");
        for (const item of organizations) {
          if (typeof item !== "object" || item === null) continue;
          const org = item as Record<string, unknown>;
          console.log(`- ${org.slug ?? "unknown"} | ${org.name ?? ""}`);
        }
      }
    });
}
