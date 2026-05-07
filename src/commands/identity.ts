import { Command } from "commander";

import { handleArg } from "../asp/handles.js";
import {
  clearDirectoryIdentity,
  findDirectoryIdentityFile,
  writeDirectoryIdentityEntry,
} from "../asp/identity.js";
import { loadConfigFromRoot, out } from "./asp-shared.js";

/**
 * `robotnet identity` — manage the directory-bound default agent identity.
 *
 * The `agent` field inside `.robotnet/config.json` binds a default agent
 * handle for the workspace's `network`. `set` writes (or overwrites) that
 * field, also seeding `network` when absent; `show` reports the current
 * binding; `clear` removes only the `agent` field, leaving any other
 * workspace settings intact.
 */
export function registerIdentityCommand(program: Command): void {
  const identity = new Command("identity").description(
    "Manage the directory-bound agent identity (.robotnet/config.json `agent` field)",
  );

  identity.addCommand(makeSetCmd());
  identity.addCommand(makeShowCmd());
  identity.addCommand(makeClearCmd());

  program.addCommand(identity);
}

function makeSetCmd(): Command {
  return new Command("set")
    .description(
      "Bind an agent handle for this workspace's network in .robotnet/config.json. " +
        "Pass `--network <name>` (top-level) to also pin a different network in the same write.",
    )
    .argument("<handle>", "Agent handle (e.g. @cli.bot)", handleArg)
    .action(async (handle: string, _opts: object, cmd: Command) => {
      const config = await loadConfigFromRoot(cmd);
      const network = config.network.name;
      const filePath = await writeDirectoryIdentityEntry(process.cwd(), {
        handle,
        network,
      });
      out(`Identity set: ${handle} on network "${network}"`);
      out(`  (stored in ${filePath})`);
    });
}

function makeShowCmd(): Command {
  return new Command("show")
    .description("Show the directory's bound agent and network")
    .option("--json", "Emit machine-readable JSON", false)
    .action(async (opts: { json: boolean }, cmd: Command) => {
      const file = await findDirectoryIdentityFile();
      if (file === undefined || file.agent === undefined) {
        if (opts.json) {
          out(JSON.stringify(null));
        } else {
          process.stderr.write(
            "No agent bound in this directory or any ancestor. " +
              "Run `robotnet identity set <handle>` to bind one.\n",
          );
        }
        process.exitCode = 1;
        return;
      }

      // Resolve current network so show can call out the case where the
      // user is operating against a network that the workspace's binding
      // does NOT cover.
      const config = await loadConfigFromRoot(cmd);
      const resolvedNetwork = config.network.name;
      const matches = file.network === resolvedNetwork;

      if (opts.json) {
        out(
          JSON.stringify(
            {
              handle: file.agent,
              network: file.network ?? null,
              file_path: file.filePath,
              resolved_network: resolvedNetwork,
              applies_to_resolved_network: matches,
            },
            null,
            2,
          ),
        );
        return;
      }
      const pad = 14;
      out(`${"handle".padEnd(pad)}  ${file.agent}`);
      out(`${"bound to".padEnd(pad)}  network "${file.network ?? "(none)"}"`);
      out(`${"file".padEnd(pad)}  ${file.filePath}`);
      if (!matches) {
        out("");
        out(
          `note: current resolved network is "${resolvedNetwork}", which does NOT match the binding. ` +
            `This binding will not contribute to commands targeting "${resolvedNetwork}" — ` +
            `pass --as <handle> for that network or remove the network override.`,
        );
      }
    });
}

function makeClearCmd(): Command {
  return new Command("clear")
    .description(
      "Remove the `agent` field from .robotnet/config.json (preserves any " +
        "other workspace settings; deletes the file if it becomes empty)",
    )
    .action(async () => {
      const removed = await clearDirectoryIdentity(process.cwd());
      if (removed) {
        out("Agent binding cleared from .robotnet/config.json.");
      } else {
        out("No agent binding to clear in this directory.");
      }
    });
}
