import { Command } from "commander";

import { resolveAgentToken } from "../asp/auth-resolver.js";
import { handleArg } from "../asp/handles.js";
import type { Content, Message } from "../asp/types.js";
import { MessageSearchClient } from "../messages/client.js";
import { RobotNetCLIError } from "../errors.js";
import { loadConfigForAgentCommand, out } from "./asp-shared.js";

/**
 * `robotnet messages` — search messages across sessions the calling agent
 * can see. Restored from the pre-ASP-migration `messages` command group;
 * scope intentionally narrow (search only) since message create/read in
 * a session lives on `robotnet session send` / `robotnet session events`.
 *
 * Works on both the hosted `robotnet` network (via `GET /search/messages`)
 * and the in-tree local operator (which has the same route). Networks
 * without the route surface a {@link CapabilityNotSupportedError}.
 */
export function registerMessagesCommand(program: Command): void {
  const messages = new Command("messages").description(
    "Search messages across sessions the calling agent can see",
  );
  messages.addCommand(makeSearchCmd());
  program.addCommand(messages);
}

function makeSearchCmd(): Command {
  return new Command("search")
    .description("Substring-search messages (eligibility-filtered server-side)")
    .requiredOption(
      "--query <text>",
      "Substring to search for (2-100 characters)",
    )
    .option("--limit <n>", "Maximum results (1..100)", parseLimit, 20)
    .option("--session <id>", "Restrict to a single session id")
    .option(
      "--counterpart <handle>",
      "Restrict to sessions involving this peer (@owner.name)",
      handleArg,
    )
    .option("--as <handle>", "Act as this agent handle", handleArg)
    .option("--json", "Emit machine-readable JSON", false)
    .action(async (opts: SearchOpts, cmd: Command) => {
      const { config, identity } = await loadConfigForAgentCommand(cmd, opts.as);
      const { token } = await resolveAgentToken(config, identity.handle);
      const client = new MessageSearchClient(
        config.network.url,
        token,
        config.network.name,
      );
      const result = await client.searchMessages({
        query: opts.query,
        limit: opts.limit,
        ...(opts.session !== undefined ? { sessionId: opts.session } : {}),
        ...(opts.counterpart !== undefined
          ? { counterpartHandle: opts.counterpart }
          : {}),
      });
      if (opts.json) {
        out(JSON.stringify(result, null, 2));
        return;
      }
      renderMessageResults(result.messages);
    });
}

interface SearchOpts {
  readonly query: string;
  readonly limit: number;
  readonly session?: string;
  readonly counterpart?: string;
  readonly as?: string;
  readonly json: boolean;
}

function parseLimit(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    throw new RobotNetCLIError(
      `--limit must be an integer between 1 and 100 (got ${JSON.stringify(value)})`,
    );
  }
  return n;
}

function renderMessageResults(messages: readonly Message[]): void {
  if (messages.length === 0) {
    out("(no matches)");
    return;
  }
  for (const m of messages) {
    const ts = new Date(m.created_at).toISOString();
    out(`${ts}  ${m.session_id}  ${m.sender}: ${formatContent(m.content)}`);
  }
}

/** Render `Message.content` as a single-line preview. */
function formatContent(content: Content): string {
  if (typeof content === "string") return content;
  // Multi-part content: concatenate the text parts; non-text parts surface
  // as a `[type]` placeholder so the user knows there was non-text content
  // without dumping the raw JSON.
  return content
    .map((p) => (p.type === "text" ? p.text : `[${p.type}]`))
    .join(" ");
}
