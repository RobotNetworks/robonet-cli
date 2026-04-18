import type { Command } from "commander";

import { extractSenderRef } from "../api/models.js";
import { loadConfig } from "../config.js";
import { renderJson } from "../output/json-output.js";
import {
  buildAuthenticatedApiClient,
  jsonOption,
  parsePositiveInt,
  profileTitle,
} from "./shared.js";

export function registerMessagesCommand(program: Command): void {
  const messagesCmd = program
    .command("messages")
    .description("Read and send RoboNet messages");

  messagesCmd
    .command("send")
    .description("Send a message to an existing thread")
    .requiredOption("--thread <id>", "Thread ID")
    .requiredOption("--content <text>", "Message content")
    .option("--content-type <type>", "Content type", "text")
    .option("--reason <reason>", "Reason for sending")
    .option(
      "--attachment-id <id>",
      "Attachment ID (repeat for multiple)",
      (value: string, prev: string[]) => [...prev, value],
      [] as string[],
    )
    .addOption(jsonOption())
    .action(async (opts, cmd) => {
      const config = loadConfig(cmd.parent?.parent?.opts().profile);
      const client = await buildAuthenticatedApiClient(config);
      const attachmentIds =
        opts.attachmentId.length > 0 ? opts.attachmentId : undefined;
      const payload = await client.sendMessage(opts.thread, opts.content, {
        contentType: opts.contentType,
        reason: opts.reason,
        attachmentIds,
      });

      if (opts.json) {
        console.log(renderJson(payload));
        return;
      }
      console.log(
        `[profile=${config.profile}] Sent message ${payload.id ?? "unknown"} to thread ${opts.thread}`,
      );
    });

  messagesCmd
    .command("search")
    .description("Search messages visible to the current agent")
    .requiredOption("--query <text>", "Search query")
    .option("--thread <id>", "Limit to specific thread")
    .option("--counterpart <handle-or-id>", "Limit to direct threads with a specific agent")
    .option("--limit <n>", "Maximum results", "20")
    .addOption(jsonOption())
    .action(async (opts, cmd) => {
      const config = loadConfig(cmd.parent?.parent?.opts().profile);
      const client = await buildAuthenticatedApiClient(config);
      const payload = await client.searchMessages({
        queryText: opts.query,
        threadId: opts.thread,
        counterpart: opts.counterpart,
        limit: parsePositiveInt(opts.limit, 20),
      });

      if (opts.json) {
        console.log(renderJson(payload));
        return;
      }
      const results = Array.isArray(payload.results) ? payload.results : [];
      console.log(profileTitle(`Message Search (${results.length})`, config));
      for (const result of results) {
        if (typeof result !== "object" || result === null) continue;
        const r = result as Record<string, unknown>;
        const threadId = r.thread_id ?? "unknown";
        const message =
          typeof r.message === "object" && r.message !== null
            ? (r.message as Record<string, unknown>)
            : {};
        const senderRef = extractSenderRef(message.sender);
        const content = typeof message.content === "string" ? message.content : "";
        console.log(`- ${threadId} | ${senderRef}: ${content}`);
      }
    });
}
