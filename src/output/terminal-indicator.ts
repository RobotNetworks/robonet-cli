const ESC = "\x1B";
const BEL = "\x07";

interface TerminalStream {
  readonly isTTY?: boolean;
  write(chunk: string): unknown;
}

export interface AgentTerminalIndicatorOptions {
  readonly handle: string;
  readonly networkName: string;
  readonly stream?: TerminalStream;
  readonly env?: Record<string, string | undefined>;
}

export interface AgentTerminalIndicator {
  close(): void;
}

/**
 * Mark an interactive terminal as hosting a live Robot Networks agent listener.
 *
 * The sequences are written to stderr by default so stdout stays a clean
 * event stream for `robotnet listen` consumers. Unsupported terminals ignore
 * the OSC sequences; non-TTY streams receive nothing.
 */
export function startAgentTerminalIndicator(
  opts: AgentTerminalIndicatorOptions,
): AgentTerminalIndicator {
  const stream = opts.stream ?? process.stderr;
  if (stream.isTTY !== true) return noopIndicator;

  const env = opts.env ?? process.env;
  const title = formatAgentTerminalTitle(opts.handle, opts.networkName);
  const chunks = [setTerminalTitle(title)];

  if (supportsProgressIndicator(env)) {
    chunks.push(setTerminalProgress("indeterminate"));
  }
  if (supportsITermBadge(env)) {
    chunks.push(setITermBadge(`Robot Networks ${opts.handle}`));
  }

  stream.write(chunks.join(""));

  let closed = false;
  return {
    close: () => {
      if (closed) return;
      closed = true;

      const cleanup = [clearTerminalTitle()];
      if (supportsProgressIndicator(env)) cleanup.push(clearTerminalProgress());
      if (supportsITermBadge(env)) cleanup.push(clearITermBadge());
      stream.write(cleanup.join(""));
    },
  };
}

export function formatAgentTerminalTitle(
  handle: string,
  networkName: string,
): string {
  return `Robot Networks: ${handle} on ${networkName}`;
}

function supportsITermBadge(env: Record<string, string | undefined>): boolean {
  return env["TERM_PROGRAM"] === "iTerm.app" || env["ITERM_SESSION_ID"] !== undefined;
}

function supportsProgressIndicator(env: Record<string, string | undefined>): boolean {
  const termProgram = env["TERM_PROGRAM"];
  return (
    termProgram === "iTerm.app" ||
    termProgram === "vscode" ||
    termProgram === "WezTerm" ||
    env["WT_SESSION"] !== undefined
  );
}

function setTerminalTitle(title: string): string {
  return osc(`2;${sanitizeOscText(title)}`);
}

function clearTerminalTitle(): string {
  return osc("2;");
}

function setTerminalProgress(state: "indeterminate"): string {
  switch (state) {
    case "indeterminate":
      return osc("9;4;3;0");
  }
}

function clearTerminalProgress(): string {
  return osc("9;4;0;0");
}

function setITermBadge(label: string): string {
  const encoded = Buffer.from(label, "utf8").toString("base64");
  return osc(`1337;SetBadgeFormat=${encoded}`);
}

function clearITermBadge(): string {
  return osc("1337;SetBadgeFormat=");
}

function osc(command: string): string {
  return `${ESC}]${command}${BEL}`;
}

function sanitizeOscText(value: string): string {
  return value.replace(/[\x00-\x1F\x7F]/g, "");
}

const noopIndicator: AgentTerminalIndicator = {
  close: () => {},
};
