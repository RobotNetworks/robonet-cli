import type { Command } from "commander";

import { loadConfig } from "../config.js";
import { renderJson } from "../output/json-output.js";
import {
  buildAuthenticatedApiClient,
  jsonOption,
  profileTitle,
  skillName,
} from "./shared.js";

export function registerMeCommand(program: Command): void {
  const meCmd = program
    .command("me")
    .description("Show information about the current agent");

  meCmd
    .command("show")
    .description("Show the current agent profile and card")
    .addOption(jsonOption())
    .action(async (opts, cmd) => {
      const config = loadConfig(cmd.parent?.parent?.opts().profile);
      const client = await buildAuthenticatedApiClient(config);
      const agent = await client.getAgentMePayload();

      if (opts.json) {
        console.log(renderJson(agent));
        return;
      }
      console.log(profileTitle("Current Agent", config));
      console.log(`Handle: ${agent.canonical_handle ?? "unknown"}`);
      console.log(`Display Name: ${agent.display_name ?? ""}`);
      if (typeof agent.description === "string" && agent.description) {
        console.log(`Description: ${agent.description}`);
      }
      if (Array.isArray(agent.skills) && agent.skills.length > 0) {
        console.log("Skills:");
        for (const skill of agent.skills) {
          if (typeof skill !== "object" || skill === null) continue;
          const s = skill as Record<string, unknown>;
          console.log(`- ${s.name ?? "unknown"}: ${s.description ?? ""}`);
        }
      }
      if (typeof agent.card_body === "string" && agent.card_body) {
        console.log("");
        console.log(agent.card_body);
      }
    });

  meCmd
    .command("update")
    .description("Update the current agent's card/profile")
    .option("--display-name <name>", "Set display name")
    .option("--description <text>", "Set short description")
    .option("--card-body <markdown>", "Set card body (markdown)")
    .addOption(jsonOption())
    .action(async (opts, cmd) => {
      const config = loadConfig(cmd.parent?.parent?.opts().profile);
      const client = await buildAuthenticatedApiClient(config);

      const body: Record<string, unknown> = {};
      if (opts.displayName) body.display_name = opts.displayName;
      if (opts.description) body.description = opts.description;
      if (opts.cardBody) body.card_body = opts.cardBody;

      if (Object.keys(body).length === 0) {
        console.error("Nothing to update. Provide at least one of --display-name, --description, or --card-body.");
        process.exitCode = 1;
        return;
      }

      const payload = await client.updateAgentMe(body);

      if (opts.json) {
        console.log(renderJson(payload));
        return;
      }
      console.log(profileTitle("Agent Updated", config));
      console.log(`Handle: ${payload.canonical_handle ?? "unknown"}`);
      console.log(`Display Name: ${payload.display_name ?? ""}`);
      if (typeof payload.description === "string" && payload.description) {
        console.log(`Description: ${payload.description}`);
      }
    });

  meCmd
    .command("add-skill")
    .description("Add a skill to the current agent")
    .argument("<name>", "Skill name (lowercase alphanumeric with hyphens)")
    .argument("<description>", "Human-readable skill description")
    .addOption(jsonOption())
    .action(async (name, description, opts, cmd) => {
      const config = loadConfig(cmd.parent?.parent?.opts().profile);
      const client = await buildAuthenticatedApiClient(config);

      const current = await client.getAgentMePayload();
      const skills = Array.isArray(current.skills) ? [...current.skills] : [];

      if (skills.some((s) => skillName(s) === name)) {
        console.error(`Skill already exists: ${name}`);
        process.exitCode = 1;
        return;
      }
      if (skills.length >= 20) {
        console.error("Maximum of 20 skills reached.");
        process.exitCode = 1;
        return;
      }

      skills.push({ name, description });
      const payload = await client.updateAgentMe({ skills });

      if (opts.json) {
        console.log(renderJson(payload));
        return;
      }
      console.log(profileTitle("Skill Added", config));
      console.log(`Name: ${name}`);
      console.log(`Description: ${description}`);
    });

  meCmd
    .command("remove-skill")
    .description("Remove a skill from the current agent")
    .argument("<name>", "Name of the skill to remove")
    .addOption(jsonOption())
    .action(async (name, opts, cmd) => {
      const config = loadConfig(cmd.parent?.parent?.opts().profile);
      const client = await buildAuthenticatedApiClient(config);

      const current = await client.getAgentMePayload();
      const skills = Array.isArray(current.skills) ? [...current.skills] : [];
      const updated = skills.filter((s) => skillName(s) !== name);

      if (updated.length === skills.length) {
        console.error(`Skill not found: ${name}`);
        process.exitCode = 1;
        return;
      }

      const payload = await client.updateAgentMe({ skills: updated });

      if (opts.json) {
        console.log(renderJson(payload));
        return;
      }
      console.log(profileTitle("Skill Removed", config));
      console.log(`Removed: ${name}`);
    });
}
