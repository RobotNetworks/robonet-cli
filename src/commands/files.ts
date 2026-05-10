import * as fs from "node:fs";
import * as path from "node:path";

import { Command } from "commander";

import { resolveAgentBearer } from "../asp/auth-resolver.js";
import { handleArg } from "../asp/handles.js";
import { AspFilesClient } from "../asp/files-client.js";
import { RobotNetCLIError } from "../errors.js";
import { loadConfigForAgentCommand, out } from "./asp-shared.js";
import { tokenOption } from "./shared.js";

/**
 * `robotnet files` — upload + download attachments referenced by
 * messages in `{type:"file", file_id:"…"}` parts.
 *
 * Auth resolution mirrors `robotnet session ...`: the agent is
 * resolved by `--as` / `ROBOTNET_AGENT` / workspace identity, and the
 * bearer comes from the credential store unless `--token` overrides
 * it.
 */
export function registerFilesCommand(program: Command): void {
  const files = new Command("files").description(
    "Upload and download files referenced by session messages",
  );
  files.addCommand(makeUploadCmd());
  files.addCommand(makeDownloadCmd());
  program.addCommand(files);
}

interface UploadOpts {
  readonly as?: string;
  readonly token?: string;
  readonly contentType?: string;
  readonly json: boolean;
}

interface DownloadOpts {
  readonly as?: string;
  readonly token?: string;
  readonly out?: string;
  readonly json: boolean;
}

function makeUploadCmd(): Command {
  return new Command("upload")
    .description(
      "Upload a file to the network. Returns a `file_id` that can be referenced from a session message.",
    )
    .argument("<path>", "Local path to the file to upload")
    .option("--as <handle>", "Act as this agent handle", handleArg)
    .option(
      "--content-type <mime>",
      "Override the content-type sent in the multipart Content-Type header (defaults to a guess from the file extension)",
    )
    .addOption(tokenOption())
    .option("--json", "Emit machine-readable JSON", false)
    .action(async (filePath: string, opts: UploadOpts, cmd: Command) => {
      const { config, identity } = await loadConfigForAgentCommand(cmd, opts.as);
      const bytes = await readFileBytes(filePath);
      const filename = path.basename(filePath);
      const contentType = opts.contentType ?? guessContentType(filename);
      const { token, baseUrl } = await resolveAgentBearer(
        config,
        identity.handle,
        opts.token,
      );
      const client = new AspFilesClient(baseUrl, token);
      const result = await client.upload({ bytes, filename, contentType });
      if (opts.json) {
        out(JSON.stringify(result, null, 2));
        return;
      }
      out(
        `Uploaded ${result.id} (${result.size_bytes} bytes, ${result.content_type}).`,
      );
      out(
        `  Reference it from a message: { "type": "file", "file_id": "${result.id}" }`,
      );
    });
}

function makeDownloadCmd(): Command {
  return new Command("download")
    .description(
      "Download a file by `file_id` (resolved against the active network) or absolute URL.",
    )
    .argument(
      "<id-or-url>",
      "`file_<…>` id (resolved against the active network) or absolute URL",
    )
    .option("--as <handle>", "Act as this agent handle", handleArg)
    .option(
      "--out <path>",
      "Write to this file instead of stdout. Required when stdout is a TTY (binary content).",
    )
    .addOption(tokenOption())
    .option(
      "--json",
      "Emit machine-readable JSON metadata (size, content-type) instead of bytes. Implies a non-empty `--out` to write the actual bytes.",
      false,
    )
    .action(async (idOrUrl: string, opts: DownloadOpts, cmd: Command) => {
      const { config, identity } = await loadConfigForAgentCommand(cmd, opts.as);
      const { token, baseUrl } = await resolveAgentBearer(
        config,
        identity.handle,
        opts.token,
      );
      const client = new AspFilesClient(baseUrl, token);
      const result = await client.download(idOrUrl);

      const targetPath = opts.out ?? null;
      if (targetPath !== null) {
        await fs.promises.writeFile(targetPath, result.bytes, { mode: 0o600 });
      } else {
        if (process.stdout.isTTY === true) {
          throw new RobotNetCLIError(
            "Refusing to write binary to a TTY. Use --out <path>.",
          );
        }
        process.stdout.write(result.bytes);
      }

      if (opts.json) {
        out(
          JSON.stringify(
            {
              content_type: result.contentType,
              size_bytes: result.bytes.length,
              filename: result.filename,
              ...(targetPath !== null ? { out_path: targetPath } : {}),
            },
            null,
            2,
          ),
        );
      } else if (targetPath !== null) {
        out(
          `Downloaded ${result.bytes.length} bytes (${result.contentType}) to ${targetPath}.`,
        );
      }
    });
}

async function readFileBytes(filePath: string): Promise<Uint8Array> {
  try {
    return await fs.promises.readFile(filePath);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new RobotNetCLIError(`Could not read ${filePath}: ${detail}`);
  }
}

const KNOWN_TYPES_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".csv": "text/csv",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
};

function guessContentType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return KNOWN_TYPES_BY_EXT[ext] ?? "application/octet-stream";
}

