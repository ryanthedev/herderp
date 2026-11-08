// Tests for the Monitor command builder (src/watch/command.ts).

import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { buildWatchCommand, WATCH_CLI_PATH } from "../../src/watch/command.js";

describe("buildWatchCommand", () => {
  it("quotes every token so a target can't break out of the command", () => {
    const cmd = buildWatchCommand({ targets: ["a b", "x'; rm -rf ~; '"] }, "/p/cli.ts");
    expect(cmd).toBe(`'bun' 'run' '/p/cli.ts' 'a b' 'x'\\''; rm -rf ~; '\\'''`);
  });

  it("appends only the flags that were set", () => {
    expect(buildWatchCommand({ targets: ["lead"], stallMs: 90000, json: true, verbose: true }, "/c")).toBe(
      "'bun' 'run' '/c' 'lead' '--stall' '90000' '--json' '--verbose'",
    );
  });

  it("points at the cli.ts that ships next to it", () => {
    expect(WATCH_CLI_PATH).toEndWith("/src/watch/cli.ts");
    expect(existsSync(WATCH_CLI_PATH)).toBe(true);
  });
});
