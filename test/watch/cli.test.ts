// Tests for the watch CLI's argument parsing (src/watch/cli.ts).

import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HerdrClient } from "../../src/herdr/client.js";
import { createNecromancy, deriveSlug } from "../../src/necromancy/core.js";
import { lastReply, parseArgs } from "../../src/watch/cli.js";

describe("parseArgs", () => {
  it("collects targets and flags, parsing durations", () => {
    expect(parseArgs(["lead", "w1:p2", "--stall", "10m", "--once", "--json", "--verbose", "--poll", "5s"])).toEqual({
      targets: ["lead", "w1:p2"],
      stallMs: 600_000,
      once: true,
      json: true,
      verbose: true,
      pollMs: 5000,
    });
  });

  it("explains what is wrong instead of guessing", () => {
    expect(parseArgs([])).toContain("at least one agent");
    expect(parseArgs(["lead", "--stall"])).toContain("--stall needs a duration");
    expect(parseArgs(["lead", "--stall", "soon"])).toContain("--stall needs a duration");
    expect(parseArgs(["lead", "--loud"])).toBe("unknown option --loud");
  });
});

describe("lastReply", () => {
  const CWD = "/tmp/last-reply-proj";
  const ID = "11111111-1111-1111-1111-111111111111";
  const jl = (v: unknown) => `${JSON.stringify(v)}\n`;

  async function withSession(content: string, check: (reply: string | undefined) => void) {
    const root = await mkdtemp(join(tmpdir(), "last-reply-"));
    try {
      await mkdir(join(root, deriveSlug(CWD)), { recursive: true });
      await writeFile(join(root, deriveSlug(CWD), `${ID}.jsonl`), content);
      const necromancy = createNecromancy({ client: {} as HerdrClient, projectsRoot: root });
      check(await lastReply(necromancy, ID, CWD));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  it("returns the agent's own last prose", async () => {
    await withSession(
      jl({ type: "user", message: { content: "fix it" } }) +
        jl({ type: "assistant", message: { content: [{ type: "text", text: "Fixed and tested." }] } }),
      (reply) => expect(reply).toBe("Fixed and tested."),
    );
  });

  it("never quotes the user's prompt or tool output as the agent's reply", async () => {
    await withSession(
      jl({ type: "user", message: { content: "please fix the login test" } }) +
        jl({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } }),
      (reply) => expect(reply).toBeUndefined(),
    );
  });
});
