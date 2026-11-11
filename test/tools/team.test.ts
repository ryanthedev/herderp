// Tests for the herdr_team tool (src/tools/team.ts): field checks named by
// tool and action, one delegation per action, and the hint on every result.

import { describe, expect, it } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTeamTools } from "../../src/tools/team.js";
import type { Team } from "../../src/team/core.js";
import { CoreError } from "../../src/core/types.js";

function setup(over: Partial<Team> = {}) {
  const calls: Array<[string, unknown]> = [];
  const team: Team = {
    start: async (args) => (calls.push(["start", args]), { target: "t9", tabId: "tb9", tabLabel: "worker p1", spaceId: "sp1", labels: {}, argv: ["claude", "go"], envPassed: [], envMissing: [], warnings: [] }),
    roster: async (args) => (calls.push(["roster", args]), { space: { id: "sp1", name: "api" }, leader: null, tree: [], attention: [], infrastructure: [], warnings: [], you: "t1" }),
    watch: async (args) => (calls.push(["watch", args]), { command: "bun run cli.ts 'core:t2'", description: "team under t2: t2", timeout_ms: 1_800_000, targets: [{ target: "t2", status: "working" }], skipped: [] }),
    recycle: async (args) => (calls.push(["recycle", args]), { successor: { target: "t9", tabId: "tb9", tabLabel: "manager" }, retired: "t2", repointed: ["t3"], self: false, warnings: [] }),
    cleanup: async (args) => (calls.push(["cleanup", args]), { dryRun: false, closed: [{ target: "t4", tabClosed: true, gone: true }], skipped: [] }),
    ...over,
  };
  const server = new McpServer({ name: "t", version: "0" });
  registerTeamTools(server, team);
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> }> })._registeredTools;
  async function call(args: Record<string, unknown>) {
    const result = await tools.herdr_team!.handler(args, {});
    const text = result.content[0]!.text;
    return { isError: result.isError === true, text, body: result.isError ? {} : JSON.parse(text) };
  }
  return { call, calls };
}

describe("herdr_team", () => {
  it("names the missing field with the tool and action", async () => {
    const s = setup();
    expect((await s.call({ action: "start", prompt: "go" })).text).toBe(`herdr_team{action:"start"} requires "kind"`);
    expect((await s.call({ action: "watch" })).text).toBe(`herdr_team{action:"watch"} requires "target"`);
    expect((await s.call({ action: "recycle" })).text).toBe(`herdr_team{action:"recycle"} requires "handoff"`);
    expect(s.calls).toEqual([]);
  });

  it("start returns the terminal and tab ids with a hint to the next call", async () => {
    const s = setup();
    const { body } = await s.call({ action: "start", kind: "claude", brief: "b.md", job: "p1" });
    expect(body).toMatchObject({ ok: true, target: "t9", tabId: "tb9", tabLabel: "worker p1" });
    expect(body.warnings).toBeUndefined();
    expect(body.hint).toContain(`herdr_team{action:'watch',target:"t9"}`);
    expect(s.calls[0]![1]).toMatchObject({ kind: "claude", brief: "b.md", job: "p1" });
  });

  it("start says so when the tab was not found or a variable was not passed", async () => {
    const s = setup({
      start: async () => ({ target: "t9", tabId: null, tabLabel: "w", spaceId: "sp1", labels: {}, argv: [], envPassed: [], envMissing: ["ENGRAM_ADDR"], warnings: ["no tab"] }),
    });
    const { body } = await s.call({ action: "start", kind: "claude", prompt: "go", job: "j" });
    expect(body.warnings).toEqual(["no tab"]);
    expect(body.hint).toContain("its tab was not found");
    expect(body.hint).toContain("not passed: ENGRAM_ADDR");
  });

  it("roster's hint says how many need a look, or that nobody does", async () => {
    expect((await setup().call({ action: "roster", stallMs: 120_000 })).body.hint).toContain("nobody needs a look; stalled means no transcript movement for 2 min");
    const busy = setup({
      roster: async () => ({ space: { id: "sp1", name: "api" }, leader: null, tree: [], infrastructure: [], warnings: [], you: null, attention: [{ target: "t3", tabLabel: "w", flags: ["permission"], why: "x", detail: "rm" }] }),
    });
    expect((await busy.call({ action: "roster" })).body.hint).toStartWith("1 need a look");
  });

  it("watch hands back the Monitor command and says it is a snapshot", async () => {
    const { body } = await setup().call({ action: "watch", target: "t2", once: true });
    expect(body).toMatchObject({ command: "bun run cli.ts 'core:t2'", timeout_ms: 1_800_000 });
    expect(body.hint).toContain("as of now");
  });

  it("recycle tells a self hand-off to stop, and anyone else how to close the old one", async () => {
    const other = await setup().call({ action: "recycle", target: "t2", handoff: "h.md" });
    expect(other.body).toMatchObject({ ok: true, retired: "t2", repointed: ["t3"] });
    expect(other.body.self).toBeUndefined();
    expect(other.body.hint).toContain(`herdr_team{action:'cleanup',targets:["t2"]}`);
    const self = setup({ recycle: async () => ({ successor: { target: "t9", tabId: null, tabLabel: "m" }, retired: "t1", repointed: [], self: true, warnings: ["w"] }) });
    const mine = await self.call({ action: "recycle", handoff: "h.md" });
    expect(mine.body.hint).toContain("finish your turn and stop");
    expect(mine.body.warnings).toEqual(["w"]);
  });

  it("cleanup's hint covers a dry run, nothing to close, and a terminal that would not go", async () => {
    expect((await setup().call({ action: "cleanup" })).body.hint).toStartWith("closed;");
    const dry = setup({ cleanup: async () => ({ dryRun: true, closed: [], skipped: [] }) });
    expect((await dry.call({ action: "cleanup", dryRun: true })).body.hint).toContain("nothing was changed");
    const none = setup({ cleanup: async () => ({ dryRun: false, closed: [], skipped: [] }) });
    expect((await none.call({ action: "cleanup" })).body.hint).toContain("nothing to close");
    const stuck = setup({ cleanup: async () => ({ dryRun: false, closed: [{ target: "t4", tabClosed: true, gone: false }], skipped: [] }) });
    expect((await stuck.call({ action: "cleanup" })).body.hint).toContain("still listed after closing: t4");
  });

  it("a typed core failure reaches the caller as [code] message", async () => {
    const s = setup({ roster: async () => { throw new CoreError("not_found", `no Herdr app space "x"`); } });
    const result = await s.call({ action: "roster", space: "x" });
    expect(result.isError).toBe(true);
    expect(result.text).toBe(`[not_found] no Herdr app space "x"`);
  });
});
