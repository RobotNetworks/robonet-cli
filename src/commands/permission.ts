import { Command } from "commander";

import { resolveAdminClient } from "../asp/auth-resolver.js";
import {
  allowlistEntriesArg,
  assertValidAllowlistEntry,
  handleArg,
} from "../asp/handles.js";
import type { AgentWire } from "../asp/types.js";
import { loadConfigFromRoot, out } from "./asp-shared.js";

/**
 * `robotnet permission` — manage agent allowlists.
 *
 * Each leaf authenticates with the admin token (same resolver as `agent`).
 */
export function registerPermissionCommand(program: Command): void {
  const permission = new Command("permission").description(
    "Manage agent allowlists on an ASP network",
  );

  permission.addCommand(makeAddCmd());
  permission.addCommand(makeRemoveCmd());
  permission.addCommand(makeShowCmd());

  program.addCommand(permission);
}

function makeAddCmd(): Command {
  return new Command("add")
    .description("Add one or more entries to an agent's allowlist")
    .argument("<handle>", "Agent handle", handleArg)
    .argument(
      "<entries...>",
      "Allowlist entries (handle or owner glob like @acme.*)",
      allowlistEntriesArg,
    )
    .addOption(adminTokenOption())
    .option("--json", "Emit machine-readable JSON", false)
    .action(
      async (
        handle: string,
        entries: string[],
        opts: PermissionOpts,
        cmd: Command,
      ) => {
        const config = await loadConfigFromRoot(cmd);
        const client = await resolveAdminClient(config, opts.adminToken);
        const agent = await client.addToAllowlist(handle, entries);
        if (opts.json) {
          out(JSON.stringify(agent, null, 2));
          return;
        }
        out(`Added ${entries.length} entry/entries to ${handle}'s allowlist.`);
        printAllowlist(agent);
      },
    );
}

function makeRemoveCmd(): Command {
  return new Command("remove")
    .description("Remove an entry from an agent's allowlist")
    .argument("<handle>", "Agent handle", handleArg)
    .argument("<entry>", "Allowlist entry to remove", (value: string) => {
      assertValidAllowlistEntry(value);
      return value;
    })
    .addOption(adminTokenOption())
    .option("--json", "Emit machine-readable JSON", false)
    .action(
      async (
        handle: string,
        entry: string,
        opts: PermissionOpts,
        cmd: Command,
      ) => {
        const config = await loadConfigFromRoot(cmd);
        const client = await resolveAdminClient(config, opts.adminToken);
        const agent = await client.removeFromAllowlist(handle, entry);
        if (opts.json) {
          out(JSON.stringify(agent, null, 2));
          return;
        }
        out(`Removed "${entry}" from ${handle}'s allowlist.`);
        printAllowlist(agent);
      },
    );
}

function makeShowCmd(): Command {
  return new Command("show")
    .description("Show an agent's current allowlist")
    .argument("<handle>", "Agent handle", handleArg)
    .addOption(adminTokenOption())
    .option("--json", "Emit machine-readable JSON", false)
    .action(async (handle: string, opts: PermissionOpts, cmd: Command) => {
      const config = await loadConfigFromRoot(cmd);
      const client = await resolveAdminClient(config, opts.adminToken);
      const agent = await client.showAgent(handle);
      if (opts.json) {
        out(
          JSON.stringify(
            { handle: agent.handle, allowlist: agent.allowlist },
            null,
            2,
          ),
        );
        return;
      }
      printAllowlist(agent);
    });
}

interface PermissionOpts {
  readonly adminToken?: string;
  readonly json?: boolean;
}

function adminTokenOption() {
  return new Command().createOption(
    "--admin-token <token>",
    "Override the stored admin token (escape hatch — usually written by the desktop app's network supervisor)",
  );
}

function printAllowlist(agent: AgentWire): void {
  out(`  handle    ${agent.handle}`);
  out(`  policy    ${agent.policy}`);
  if (agent.allowlist.length === 0) {
    out(`  allowlist (empty)`);
  } else {
    out(`  allowlist`);
    for (const entry of agent.allowlist) {
      out(`    ${entry}`);
    }
  }
}
