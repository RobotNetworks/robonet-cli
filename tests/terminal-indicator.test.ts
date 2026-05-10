import { describe, it } from "node:test";
import * as assert from "node:assert/strict";

import {
  formatAgentTerminalTitle,
  startAgentTerminalIndicator,
} from "../src/output/terminal-indicator.js";

const ESC = "\x1B";
const BEL = "\x07";

class CaptureStream {
  readonly chunks: string[] = [];

  constructor(readonly isTTY: boolean) {}

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  output(): string {
    return this.chunks.join("");
  }
}

describe("formatAgentTerminalTitle", () => {
  it("includes the active agent handle and network", () => {
    assert.equal(
      formatAgentTerminalTitle("@cli.bot", "local"),
      "Robot Networks: @cli.bot on local",
    );
  });
});

describe("startAgentTerminalIndicator", () => {
  it("does not write escape sequences when stderr is not a TTY", () => {
    const stream = new CaptureStream(false);
    const indicator = startAgentTerminalIndicator({
      handle: "@cli.bot",
      networkName: "local",
      stream,
      env: { TERM_PROGRAM: "iTerm.app" },
    });

    indicator.close();

    assert.equal(stream.output(), "");
  });

  it("sets and clears a portable terminal title on TTY streams", () => {
    const stream = new CaptureStream(true);
    const indicator = startAgentTerminalIndicator({
      handle: "@cli.bot",
      networkName: "local",
      stream,
      env: { TERM_PROGRAM: "Apple_Terminal" },
    });

    assert.equal(stream.output(), osc("2;Robot Networks: @cli.bot on local"));

    indicator.close();
    assert.equal(
      stream.output(),
      osc("2;Robot Networks: @cli.bot on local") + osc("2;"),
    );
  });

  it("adds progress and badge hints for iTerm2", () => {
    const stream = new CaptureStream(true);
    const indicator = startAgentTerminalIndicator({
      handle: "@cli.bot",
      networkName: "local",
      stream,
      env: { TERM_PROGRAM: "iTerm.app" },
    });
    const badge = Buffer.from("Robot Networks @cli.bot", "utf8").toString("base64");

    assert.equal(
      stream.output(),
      osc("2;Robot Networks: @cli.bot on local") +
        osc("9;4;3;0") +
        osc(`1337;SetBadgeFormat=${badge}`),
    );

    indicator.close();
    indicator.close();
    assert.equal(
      stream.output(),
      osc("2;Robot Networks: @cli.bot on local") +
        osc("9;4;3;0") +
        osc(`1337;SetBadgeFormat=${badge}`) +
        osc("2;") +
        osc("9;4;0;0") +
        osc("1337;SetBadgeFormat="),
    );
  });

  it("strips control characters before writing OSC title text", () => {
    const stream = new CaptureStream(true);

    startAgentTerminalIndicator({
      handle: "@cli\u001B]2;bad\u0007.bot",
      networkName: "local",
      stream,
      env: {},
    });

    assert.equal(
      stream.output(),
      osc("2;Robot Networks: @cli]2;bad.bot on local"),
    );
  });
});

function osc(command: string): string {
  return `${ESC}]${command}${BEL}`;
}
