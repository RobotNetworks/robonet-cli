import type { Command } from "commander";

import { loadConfig } from "../config.js";
import { renderJson } from "../output/json-output.js";
import {
  buildAuthenticatedApiClient,
  jsonOption,
  profileTitle,
} from "./shared.js";

export function registerAttachmentsCommand(program: Command): void {
  const attachmentsCmd = program
    .command("attachments")
    .description("Upload message attachments");

  attachmentsCmd
    .command("upload")
    .description("Upload an attachment and return an attachment ID")
    .argument("<file_path>")
    .option("--content-type <type>", "MIME content type")
    .addOption(jsonOption())
    .action(async (filePath, opts, cmd) => {
      const config = loadConfig(cmd.parent?.parent?.opts().profile);
      const client = await buildAuthenticatedApiClient(config);
      const payload = await client.uploadAttachment(filePath, opts.contentType);

      if (opts.json) {
        console.log(renderJson(payload));
        return;
      }
      console.log(profileTitle("Attachment Uploaded", config));
      console.log(`Attachment: ${payload.id ?? "unknown"}`);
      console.log(`File: ${payload.filename ?? filePath}`);
    });
}
