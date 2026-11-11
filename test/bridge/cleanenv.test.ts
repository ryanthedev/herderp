// Regression test for agents inheriting another Claude session's markers
// (src/bridge/cleanenv.ts). Verified 2026-11-08: a core installed from a
// Claude shell gave every new terminal CLAUDE_CODE_CHILD_SESSION=1, so the
// Claudes started there saved no transcript. The launch line must strip it.

import { describe, expect, it } from "bun:test";
import { CLAUDE_SESSION_MARKERS, cleanLaunch } from "../../src/bridge/cleanenv.js";

describe("cleanLaunch", () => {
  it("wraps the agent in env -u for every marker, then runs it unchanged", () => {
    const argv = cleanLaunch(["claude", "--resume", "abc"]);
    expect(argv[0]).toBe("env");
    expect(argv.slice(-3)).toEqual(["claude", "--resume", "abc"]);
    for (const name of ["CLAUDE_CODE_CHILD_SESSION", "CLAUDECODE", "CLAUDE_PID", "CLAUDE_CODE_SESSION_ID", "HERDR_APP_HOME"]) {
      expect(argv[argv.indexOf(name) - 1]).toBe("-u");
    }
  });

  it("keeps the terminal's own herdr-core identity", () => {
    expect(CLAUDE_SESSION_MARKERS).not.toContain("HC_TERMINAL_ID");
    expect(CLAUDE_SESSION_MARKERS).not.toContain("HC_SCOPE");
  });

  it("really strips them: a child run through the line sees none of the markers, and keeps the rest", async () => {
    const polluted: Record<string, string> = { ...(process.env as Record<string, string>), HC_TERMINAL_ID: "t99", KEEP_ME: "yes" };
    for (const name of CLAUDE_SESSION_MARKERS) polluted[name] = "1";
    const proc = Bun.spawn(cleanLaunch(["sh", "-c", "env"]), { env: polluted, stdout: "pipe" });
    const seen = new Map(
      (await new Response(proc.stdout).text())
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    await proc.exited;
    for (const name of CLAUDE_SESSION_MARKERS) expect(seen.has(name)).toBe(false);
    expect(seen.get("HC_TERMINAL_ID")).toBe("t99");
    expect(seen.get("KEEP_ME")).toBe("yes");
  });
});
