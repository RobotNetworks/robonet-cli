import { Command } from "commander";

import { handleArg } from "../asp/handles.js";
import {
  clearDirectoryIdentity,
  findDirectoryIdentity,
  writeDirectoryIdentity,
} from "../asp/identity.js";
import { loadConfigFromRoot, out } from "./asp-shared.js";

/**
 * `robotnet identity` — manage the project-bound default agent identity.
 *
 * The identity lives in `.robotnet/asp.json` (same shape as `asp identity set`
 * writes; both CLIs interoperate by reading the same file). Commands that
 * need an agent handle fall back to this file when `--as` is not provided.
 */
export function registerIdentityCommand(program: Command): void {
  const identity = new Command("identity").description(
    "Manage the directory-bound default agent identity (.robotnet/asp.json)",
  );

  identity.addCommand(makeSetCmd());
  identity.addCommand(makeShowCmd());
  identity.addCommand(makeClearCmd());

  program.addCommand(identity);
}

function makeSetCmd(): Command {
  return new Command("set")
    .description(
      "Write a default agent identity for this directory to .robotnet/asp.json",
    )
    .argument("<handle>", "Agent handle (e.g. @cli.bot)", handleArg)
    .action(async (handle: string, _opts: object, cmd: Command) => {
      const config = loadConfigFromRoot(cmd);
      const network = config.network.name;
      const filePath = await writeDirectoryIdentity(process.cwd(), {
        handle,
        network,
      });
      out(`Identity set: ${handle} on network "${network}"`);
      out(`  (stored in ${filePath})`);
    });
}

function makeShowCmd(): Command {
  return new Command("show")
    .description(
      "Show the resolved directory identity (walks up from the current directory)",
    )
    .option("--json", "Emit machine-readable JSON", false)
    .action(async (opts: { json: boolean }) => {
      const identity = await findDirectoryIdentity();
      if (!identity) {
        if (opts.json) {
          out(JSON.stringify(null));
        } else {
          out(
            "No identity set. Run `robotnet identity set <handle>` to create one.",
          );
        }
        return;
      }
      if (opts.json) {
        out(
          JSON.stringify(
            {
              handle: identity.handle,
              network: identity.network,
              file_path: identity.filePath,
            },
            null,
            2,
          ),
        );
        return;
      }
      const pad = 10;
      out(`${"handle".padEnd(pad)}  ${identity.handle}`);
      out(`${"network".padEnd(pad)}  ${identity.network}`);
      out(`${"file".padEnd(pad)}  ${identity.filePath}`);
    });
}

function makeClearCmd(): Command {
  return new Command("clear")
    .description("Remove .robotnet/asp.json from the current directory")
    .action(async () => {
      const removed = await clearDirectoryIdentity(process.cwd());
      if (removed) {
        out("Identity cleared (.robotnet/asp.json removed).");
      } else {
        out("No identity file found in this directory.");
      }
    });
}
