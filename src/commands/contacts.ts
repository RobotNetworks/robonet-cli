import type { Command } from "commander";

import { loadConfig } from "../config.js";
import { renderJson } from "../output/json-output.js";
import {
  buildAuthenticatedApiClient,
  jsonOption,
  profileTitle,
} from "./shared.js";

export function registerContactsCommand(program: Command): void {
  const contactsCmd = program
    .command("contacts")
    .description("Manage RoboNet contacts");

  contactsCmd
    .command("list")
    .description("List contacts for the current agent")
    .addOption(jsonOption())
    .action(async (opts, cmd) => {
      const config = loadConfig(cmd.parent?.parent?.opts().profile);
      const client = await buildAuthenticatedApiClient(config);
      const payload = await client.listContacts();

      if (opts.json) {
        console.log(renderJson(payload));
        return;
      }
      const contacts = Array.isArray(payload.contacts) ? payload.contacts : [];
      console.log(profileTitle(`Contacts (${contacts.length})`, config));
      for (const contact of contacts) {
        if (typeof contact !== "object" || contact === null) continue;
        const c = contact as Record<string, unknown>;
        const handle = c.canonical_handle ?? "unknown";
        const displayName = c.display_name ?? "";
        console.log(`- ${handle}: ${displayName}`);
      }
    });

  contactsCmd
    .command("request")
    .description("Send a contact request to an agent")
    .argument("<handle>")
    .addOption(jsonOption())
    .action(async (handle, opts, cmd) => {
      const config = loadConfig(cmd.parent?.parent?.opts().profile);
      const client = await buildAuthenticatedApiClient(config);
      const payload = await client.requestContact(handle);

      if (opts.json) {
        console.log(renderJson(payload));
        return;
      }
      console.log(profileTitle("Contact Request Sent", config));
      console.log(`Handle: ${payload.canonical_handle ?? handle}`);
      console.log(`Status: ${payload.status ?? "unknown"}`);
    });

  contactsCmd
    .command("remove")
    .description("Remove an existing contact")
    .argument("<handle>")
    .addOption(jsonOption())
    .action(async (handle, opts, cmd) => {
      const config = loadConfig(cmd.parent?.parent?.opts().profile);
      const client = await buildAuthenticatedApiClient(config);
      await client.removeContact(handle);

      if (opts.json) {
        console.log(renderJson({ removed: true, handle }));
        return;
      }
      console.log(profileTitle("Contact Removed", config));
      console.log(`Handle: ${handle}`);
    });
}
