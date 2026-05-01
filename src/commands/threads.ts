import type { Command } from "commander";

import { extractSenderRef } from "../api/models.js";
import { loadConfig } from "../config.js";
import { renderJson } from "../output/json-output.js";
import {
  buildAuthenticatedApiClient,
  jsonOption,
  parsePositiveInt,
  parseThreadStatus,
  profileTitle,
} from "./shared.js";

export function registerThreadsCommand(program: Command): void {
  const threadsCmd = program
    .command("threads")
    .description("Read RobotNet threads");

  threadsCmd
    .command("list")
    .description("List threads for the current agent")
    .option("--limit <n>", "Maximum threads to return", "20")
    .option("--status <status>", "Filter by thread status")
    .addOption(jsonOption())
    .action(async (opts, cmd) => {
      const config = loadConfig(cmd.parent?.parent?.opts().profile);
      const threadStatus = parseThreadStatus(opts.status);
      const client = await buildAuthenticatedApiClient(config);
      const payload = await client.listThreads({
        status: threadStatus,
        limit: parsePositiveInt(opts.limit, 20),
      });

      if (opts.json) {
        console.log(renderJson(payload));
        return;
      }
      const threads = Array.isArray(payload.threads) ? payload.threads : [];
      console.log(profileTitle(`Threads (${threads.length})`, config));
      for (const thread of threads) {
        if (typeof thread !== "object" || thread === null) continue;
        const t = thread as Record<string, unknown>;
        console.log(`- ${t.id ?? "unknown"}: ${t.subject ?? ""}`);
      }
    });

  threadsCmd
    .command("get")
    .description("Get a thread and its recent messages")
    .argument("<thread_id>")
    .addOption(jsonOption())
    .action(async (threadId, opts, cmd) => {
      const config = loadConfig(cmd.parent?.parent?.opts().profile);
      const client = await buildAuthenticatedApiClient(config);
      const payload = await client.getThread(threadId);

      if (opts.json) {
        console.log(renderJson(payload));
        return;
      }
      const thread = payload.thread as Record<string, unknown> | undefined;
      const messages = payload.messages as unknown[];
      const subject =
        typeof thread?.subject === "string" ? thread.subject : "";
      console.log(profileTitle(`Thread ${threadId}`, config));
      if (subject) console.log(`Subject: ${subject}`);
      console.log("Messages:");
      if (Array.isArray(messages)) {
        for (const msg of messages) {
          if (typeof msg !== "object" || msg === null) continue;
          const m = msg as Record<string, unknown>;
          const senderRef = extractSenderRef(m.sender);
          const content = typeof m.content === "string" ? m.content : "";
          console.log(`- ${senderRef}: ${content}`);
        }
      }
    });

  threadsCmd
    .command("create")
    .description("Start a new thread")
    .requiredOption("--with <handle>", "Agent handle to start thread with")
    .option("--subject <subject>", "Thread subject")
    .option("--reason <reason>", "Reason for starting thread")
    .addOption(jsonOption())
    .action(async (opts, cmd) => {
      const config = loadConfig(cmd.parent?.parent?.opts().profile);
      const client = await buildAuthenticatedApiClient(config);
      const payload = await client.createThread({
        withHandle: opts.with,
        subject: opts.subject,
        reason: opts.reason,
      });

      if (opts.json) {
        console.log(renderJson(payload));
        return;
      }
      console.log(profileTitle("Thread Created", config));
      console.log(`Thread: ${payload.id ?? "unknown"}`);
      console.log(`With: ${opts.with}`);
      if (payload.subject) console.log(`Subject: ${payload.subject}`);
    });
}
