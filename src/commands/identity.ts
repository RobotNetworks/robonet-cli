import { Command } from "commander";

import { handleArg } from "../asp/handles.js";
import {
  clearDirectoryIdentity,
  findDirectoryIdentityFile,
  lookupDirectoryHandle,
  writeDirectoryIdentityEntry,
} from "../asp/identity.js";
import { loadConfigFromRoot, out } from "./asp-shared.js";

/**
 * `robotnet identity` — manage the project-bound default agent identities.
 *
 * The file at `.robotnet/asp.json` is a network-keyed map: each entry binds
 * a handle for one network. `set` adds or updates the entry for the
 * resolved network; `show` reports the entry for the resolved network (or
 * the full map under `--all`); `clear` removes the file entirely.
 *
 * Both this CLI and the open `asp` CLI write the same file shape so
 * project workspaces stay portable.
 */
export function registerIdentityCommand(program: Command): void {
  const identity = new Command("identity").description(
    "Manage the directory-bound agent identities (.robotnet/asp.json)",
  );

  identity.addCommand(makeSetCmd());
  identity.addCommand(makeShowCmd());
  identity.addCommand(makeClearCmd());

  program.addCommand(identity);
}

function makeSetCmd(): Command {
  return new Command("set")
    .description(
      "Bind an agent handle for the resolved network (.robotnet/asp.json). " +
        "Other networks' entries are preserved.",
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
    .description(
      "Show the directory identity bound to the resolved network. " +
        "Pass --all to dump the full map across all networks.",
    )
    .option("--all", "Show every network entry, not just the resolved one", false)
    .option("--json", "Emit machine-readable JSON", false)
    .action(async (opts: { all: boolean; json: boolean }, cmd: Command) => {
      const file = await findDirectoryIdentityFile();
      if (file === undefined) {
        if (opts.json) {
          out(JSON.stringify(null));
        } else {
          process.stderr.write(
            "No identity file in this directory or any ancestor. " +
              "Run `robotnet identity set <handle>` to create one.\n",
          );
        }
        process.exitCode = 1;
        return;
      }

      if (opts.all) {
        if (opts.json) {
          out(
            JSON.stringify(
              {
                file_path: file.filePath,
                default_network: file.defaultNetwork ?? null,
                identities: file.identities,
              },
              null,
              2,
            ),
          );
          return;
        }
        const pad = 12;
        out(`${"file".padEnd(pad)}  ${file.filePath}`);
        if (file.defaultNetwork !== undefined) {
          out(`${"default".padEnd(pad)}  ${file.defaultNetwork}`);
        }
        const entries = Object.entries(file.identities);
        if (entries.length === 0) {
          out("(no identities bound)");
        } else {
          for (const [network, handle] of entries) {
            out(`${network.padEnd(pad)}  ${handle}`);
          }
        }
        return;
      }

      const config = await loadConfigFromRoot(cmd);
      const network = config.network.name;
      const handle = lookupDirectoryHandle(file, network);
      if (handle === undefined) {
        if (opts.json) {
          out(JSON.stringify(null));
        } else {
          const known = Object.keys(file.identities).sort().join(", ") || "(none)";
          process.stderr.write(
            `No identity bound for network "${network}" in ${file.filePath} ` +
              `(bound networks: ${known}). ` +
              `Run \`robotnet --network ${network} identity set <handle>\` to bind one, ` +
              `or pass --all to see every entry.\n`,
          );
        }
        process.exitCode = 1;
        return;
      }

      if (opts.json) {
        out(
          JSON.stringify(
            {
              handle,
              network,
              file_path: file.filePath,
            },
            null,
            2,
          ),
        );
        return;
      }
      const pad = 10;
      out(`${"handle".padEnd(pad)}  ${handle}`);
      out(`${"network".padEnd(pad)}  ${network}`);
      out(`${"file".padEnd(pad)}  ${file.filePath}`);
    });
}

function makeClearCmd(): Command {
  return new Command("clear")
    .description("Remove .robotnet/asp.json from the current directory")
    .action(async () => {
      const removed = await clearDirectoryIdentity(process.cwd());
      if (removed) {
        out("Identity file cleared (.robotnet/asp.json removed).");
      } else {
        out("No identity file found in this directory.");
      }
    });
}
