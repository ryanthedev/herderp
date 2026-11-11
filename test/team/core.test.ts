// Tests for the team orchestration (src/team/core.ts) against a stub
// CoreClient that records every call. No process is started, no clock read.

import { describe, expect, it } from "bun:test";
import { createTeam, TAB_WAIT_MS, type TeamDeps } from "../../src/team/core.js";
import { CLAUDE_SESSION_MARKERS } from "../../src/bridge/cleanenv.js";
import type { CoreClient } from "../../src/core/client.js";
import { CoreError, type AppSpace, type CoreTerminal } from "../../src/core/types.js";

const SPACE = "sp-team";
const OTHER = "sp-other";
const LEAD_ARGV = ["claude", "--settings", "/s.json", "--plugin-dir", "/p/engram", "--plugin-dir", "/p/herderp", "--model", "opus", "Read brief and do it."];

function terminal(address: string, over: Partial<CoreTerminal> = {}): CoreTerminal {
  const labels = { "herdr.space": SPACE, ...over.labels };
  return {
    address, name: null, state: "live", app: "claude-code", status: "done", blockedKind: null, message: "", title: "", turn: 1,
    cwd: "/repo", foreground: { pid: 1, argv: ["claude"], cwd: "/repo" }, argv: LEAD_ARGV, createdMs: Number(address.replace(/\D/g, "")),
    parent: null, tabId: null, where: null, machine: null, ...over, labels, spaceId: labels["herdr.space"] || null,
  };
}

interface World {
  terminals: CoreTerminal[];
  spaces: AppSpace[];
}

function tab(id: string, name: string, ...terminals: string[]) {
  return { id, name, active: false, terminals: terminals.map((t) => ({ terminal: t, pane: `p-${t}`, status: null, app: null, name: null })) };
}

function setup(world: World, opts: { env?: NodeJS.ProcessEnv; core?: Partial<CoreClient>; files?: string[]; tabAppearsAfter?: number } = {}) {
  const calls: string[] = [];
  let slept = 0;
  let next = 900;
  let spacesAsked = 0;
  const core = {
    terminalList: async () => ({ terminals: world.terminals, machines: [] }),
    terminalGet: async (id: string) => {
      const found = world.terminals.find((t) => t.address === id);
      if (!found) throw new CoreError("not_found", `no terminal "${id}"`);
      return found;
    },
    terminalRead: async () => ({ text: "   Opus 5.5 ·  medium ·  42%", complete: true, how: "screen", why: null }),
    terminalRun: async (run: { argv: string[]; cwd: string; labels?: Record<string, string>; env?: Record<string, string> }) => {
      calls.push(`run ${JSON.stringify(run)}`);
      const started = terminal(`t${next++}`, { labels: run.labels, argv: run.argv, cwd: run.cwd, status: "working" });
      world.terminals.push(started);
      return started;
    },
    terminalLabel: async (id: string, labels: Record<string, string>) => {
      calls.push(`label ${id} ${JSON.stringify(labels)}`);
      const t = world.terminals.find((x) => x.address === id)!;
      for (const [k, v] of Object.entries(labels)) v === "" ? delete t.labels[k] : (t.labels[k] = v);
      return t;
    },
    terminalKill: async (id: string) => {
      calls.push(`kill ${id}`);
      const t = world.terminals.find((x) => x.address === id);
      if (!t) throw new CoreError("not_found", "gone");
      t.state = "finished";
      return t;
    },
    terminalRm: async (id: string) => {
      calls.push(`rm ${id}`);
      world.terminals = world.terminals.filter((x) => x.address !== id);
    },
    appSpaces: async () => {
      spacesAsked++;
      const fresh = world.terminals.filter((t) => Number(t.address.slice(1)) >= 900);
      if (spacesAsked <= (opts.tabAppearsAfter ?? 0)) return world.spaces;
      // The window gives a new terminal a numbered tab of its own.
      return world.spaces.map((s) =>
        s.id !== SPACE ? s : { ...s, tabs: [...s.tabs, ...fresh.filter((t) => !s.tabs.some((x) => x.terminals.some((r) => r.terminal === t.address))).map((t) => tab(`tb-${t.address}`, "7", t.address))] },
      );
    },
    appDo: async (command: string, args: Record<string, unknown>) => {
      calls.push(`app ${command} ${JSON.stringify(args)}`);
      return {};
    },
    ...opts.core,
  } as unknown as CoreClient;
  const deps: TeamDeps = {
    core,
    sessions: async (t) => `session-${t.address}`,
    env: opts.env ?? { HC_TERMINAL_ID: "t1" },
    lastReply: async (session) => (session === "session-t3" ? "Done.\nShall I push?" : "All good."),
    activityAt: async () => 1_000,
    fileExists: async (path) => (opts.files ?? []).includes(path),
    sleep: async (ms) => void (slept += ms),
    now: () => 2_000,
  };
  return { team: createTeam(deps), calls, slept: () => slept };
}

const plenary = (): World => ({
  terminals: [
    terminal("t1", { labels: { role: "orchestrator", plenary: "proxy" } }),
    terminal("t2", { labels: { plenary: "manager", "plenary.reports-to": "t1" } }),
    terminal("t3", { labels: { job: "p1", "reports-to": "t2" } }),
    terminal("t4", { labels: { job: "p1v", "reports-to": "t2", retired: "t9" }, status: "done" }),
    terminal("t5", { labels: {} }), // someone's own session in the space: no team label
    terminal("t6", { labels: { "herdr.space": OTHER, job: "x", "reports-to": "t1", retired: "t8" } }),
    terminal("t7", { labels: {}, app: "", status: null, foreground: { pid: 2, argv: ["-zsh"], cwd: "/repo" } }),
  ],
  spaces: [
    { id: SPACE, name: "plenary", folder: "/repo", machine: null, active: true, tabs: [tab("tb1", "★ proxy", "t1"), tab("tb2", "manager engine", "t2"), tab("tb3", "worker p1", "t3"), tab("tb4", "retired verifier p1v", "t4"), tab("tb5", "1", "t5", "t7")] },
    { id: OTHER, name: "other", folder: "/o", machine: null, active: false, tabs: [tab("tb6", "x", "t6")] },
  ],
});

const failure = (p: Promise<unknown>): Promise<Error & { code?: string }> =>
  p.then(
    () => {
      throw new Error("expected a rejection");
    },
    (e: unknown) => e as Error & { code?: string },
  );

describe("start", () => {
  it("launches clean and unparented with the caller's plugin set, labels it, finds its tab and renames it", async () => {
    const s = setup(plenary());
    const started = await s.team.start({ kind: "claude", brief: "docs/briefs/p2.md", role: "worker", job: "p2" });
    expect(started).toMatchObject({ target: "t900", tabId: "tb-t900", tabLabel: "worker p2", spaceId: SPACE, warnings: [] });
    const run = JSON.parse(s.calls[0]!.slice(4));
    expect(run.argv.slice(0, 1 + CLAUDE_SESSION_MARKERS.length * 2)).toEqual(["env", ...CLAUDE_SESSION_MARKERS.flatMap((m) => ["-u", m])]);
    expect(run.argv.slice(1 + CLAUDE_SESSION_MARKERS.length * 2)).toEqual([
      "claude", "--settings", "/s.json", "--plugin-dir", "/p/engram", "--plugin-dir", "/p/herderp", "Read docs/briefs/p2.md and do it.",
    ]);
    expect(run.cwd).toBe("/repo");
    expect(run.labels).toEqual({ "herdr.space": SPACE, role: "worker", job: "p2", "reports-to": "t1" });
    expect(s.calls[1]).toBe(`app tab.rename {"id":"tb-t900","name":"worker p2"}`);
  });

  it("goes through the caller's login shell when there is one, so the member gets the user's own environment", async () => {
    const s = setup(plenary(), { env: { HC_TERMINAL_ID: "t1", SHELL: "/bin/zsh" } });
    await s.team.start({ kind: "claude", prompt: "go", job: "j" });
    expect(JSON.parse(s.calls[0]!.slice(4)).argv.slice(0, 6)).toEqual(["/bin/zsh", "-lic", 'exec "$@"', "zsh", "env", "-u"]);
  });

  it("explicit plugins, argv, labels, space by name, reportsTo and tabLabel all override the defaults", async () => {
    const s = setup(plenary());
    const started = await s.team.start({
      kind: "claude", prompt: "go", job: "p3", tabLabel: "worker p3 (engine): scaffold", space: "plenary", reportsTo: "t2",
      settings: "/other.json", pluginDirs: ["/p/sdd"], argv: ["--model", "haiku"], labels: { track: "engine" }, cwd: "/elsewhere",
    });
    expect(started.argv).toEqual(["claude", "--settings", "/other.json", "--plugin-dir", "/p/sdd", "--model", "haiku", "go"]);
    expect(started.labels).toEqual({ track: "engine", "herdr.space": SPACE, job: "p3", "reports-to": "t2" });
    expect(started.tabLabel).toBe("worker p3 (engine): scaffold");
    expect(JSON.parse(s.calls[0]!.slice(4)).cwd).toBe("/elsewhere");
  });

  it("reportsTo 'none' starts a top-of-tree member; a non-claude kind gets no Claude flags", async () => {
    const s = setup(plenary());
    const started = await s.team.start({ kind: "codex", prompt: "review", role: "orchestrator", reportsTo: "none" });
    expect(started.argv).toEqual(["codex", "review"]);
    expect(started.labels).toEqual({ "herdr.space": SPACE, role: "orchestrator" });
  });

  it("passEnv copies named variables from the caller and reports the unset ones, never the values", async () => {
    const s = setup(plenary(), { env: { HC_TERMINAL_ID: "t1", ENGRAM_ADDR: "host:1", ENGRAM_TOKEN: "secret" } });
    const started = await s.team.start({ kind: "claude", prompt: "go", job: "j", passEnv: ["ENGRAM_ADDR", "ENGRAM_TOKEN", "NOPE"] });
    expect(JSON.parse(s.calls[0]!.slice(4)).env).toEqual({ ENGRAM_ADDR: "host:1", ENGRAM_TOKEN: "secret" });
    expect(started.envPassed).toEqual(["ENGRAM_ADDR", "ENGRAM_TOKEN"]);
    expect(started.envMissing).toEqual(["NOPE"]);
    expect(JSON.stringify(started)).not.toContain("secret");
  });

  it("waits for the window to show the tab, without a real clock", async () => {
    const s = setup(plenary(), { tabAppearsAfter: 4 });
    const started = await s.team.start({ kind: "claude", prompt: "go", job: "j" });
    expect(started.tabId).toBe("tb-t900");
    expect(s.slept()).toBe(750);
  });

  it("a tab that never appears still returns the running member, with tabId null and a warning", async () => {
    const s = setup(plenary(), { tabAppearsAfter: 1e9 });
    const started = await s.team.start({ kind: "claude", prompt: "go", job: "j" });
    expect(started).toMatchObject({ target: "t900", tabId: null });
    expect(started.warnings[0]).toContain("no tab for t900");
    expect(s.slept()).toBeGreaterThanOrEqual(TAB_WAIT_MS);
    expect(s.calls.some((c) => c.startsWith("app tab.rename"))).toBe(false);
  });

  it("a failed rename is a warning, not a lost member", async () => {
    const s = setup(plenary(), { core: { appDo: async () => { throw new CoreError("app_error", "no such tab"); } } });
    const started = await s.team.start({ kind: "claude", prompt: "go", job: "j" });
    expect(started.target).toBe("t900");
    expect(started.warnings[0]).toContain("was not renamed");
  });

  it("names what is missing or refused, before starting anything", async () => {
    const s = setup(plenary());
    expect((await failure(s.team.start({ kind: "claude", job: "j" }))).message).toBe(`herdr_team{action:"start"} requires "prompt" or "brief"`);
    expect((await failure(s.team.start({ kind: "claude", prompt: "go" }))).message).toContain(`requires "role", "job" or "tabLabel"`);
    expect((await failure(s.team.start({ kind: "claude", prompt: "go", job: "j", labels: { "herdr.space": "sp-x" } }))).message).toContain(`label "herdr.space"`);
    expect((await failure(s.team.start({ kind: "claude", prompt: "go", job: "j", labels: { "reports-to": "t9" } }))).message).toContain(`label "reports-to"`);
    expect((await failure(s.team.start({ kind: "codex", prompt: "go", job: "j", pluginDirs: ["/p"] }))).message).toContain("Claude Code flags");
    expect((await failure(s.team.start({ kind: "claude", prompt: "go", job: "j", space: "nope" }))).code).toBe("not_found");
    expect((await failure(s.team.start({ kind: "claude", prompt: "go", job: "j", reportsTo: "t404" }))).code).toBe("not_found");
    expect(s.calls).toEqual([]);
  });

  it("outside the Herdr app there are no defaults: space and reportsTo must be named", async () => {
    const s = setup(plenary(), { env: {} });
    expect((await failure(s.team.start({ kind: "claude", prompt: "go", job: "j" }))).message).toContain(`requires "space"`);
    expect((await failure(s.team.start({ kind: "claude", prompt: "go", job: "j", space: SPACE }))).message).toContain(`requires "reportsTo"`);
    const started = await s.team.start({ kind: "claude", prompt: "go", job: "j", space: SPACE, reportsTo: "t2" });
    expect(started.argv).toEqual(["claude", "go"]);
    expect(JSON.parse(s.calls[0]!.slice(4)).cwd).toBe("/repo"); // the space's folder
  });

  it("refuses a space on another machine", async () => {
    const world = plenary();
    world.spaces[0]!.machine = "ska";
    expect((await failure(setup(world).team.start({ kind: "claude", prompt: "go", job: "j", space: SPACE }))).code).toBe("unsupported_remote");
  });
});

describe("roster", () => {
  it("gathers each agent member's tab, context, last reply and flags into the tree; shells and other spaces stay out", async () => {
    const roster = await setup(plenary()).team.roster({});
    expect(roster.space).toEqual({ id: SPACE, name: "plenary" });
    expect(roster.leader).toBe("t1");
    expect(roster.you).toBe("t1");
    expect(roster.tree.map((m) => m.target)).toEqual(["t1", "t5"]);
    const lead = roster.tree[0]!;
    expect(lead).toMatchObject({ you: true, tabId: "tb1", tabLabel: "★ proxy", contextPct: 42, lastMessage: "All good." });
    expect(lead.reports.map((m) => m.target)).toEqual(["t2"]);
    expect(lead.reports[0]!.reports.map((m) => [m.target, m.flags])).toEqual([["t3", ["question"]], ["t4", ["retired"]]]);
    expect(roster.attention.map((a) => a.target)).toEqual(["t3"]);
  });

  it("degrades per member: an unreadable screen or session leaves nulls, not a failed roster", async () => {
    const s = setup(plenary(), { core: { terminalRead: async () => { throw new CoreError("timeout", "slow"); } } });
    const roster = await s.team.roster({ space: "plenary" });
    expect(roster.tree[0]).toMatchObject({ target: "t1", contextPct: null, lastMessage: "All good." });
  });

  it("still answers when the window is down, without tab names, and says so", async () => {
    const s = setup(plenary(), { core: { appSpaces: async () => { throw new CoreError("app_unreachable", "window not running"); } } });
    const roster = await s.team.roster({});
    expect(roster.tree[0]).toMatchObject({ target: "t1", tabLabel: null });
    expect(roster.warnings).toContain("the Herdr window did not answer, so tab ids and tab labels are missing");
  });
});

describe("watch", () => {
  it("covers a member and everyone under it, skipping those that have exited", async () => {
    const world = plenary();
    world.terminals.push(terminal("t8", { labels: { "reports-to": "t2" }, foreground: { pid: 3, argv: ["zsh", "-l"], cwd: "/" } }));
    const plan = await setup(world).team.watch({ target: "t2", stallMs: 600_000 });
    expect(plan.targets.map((t) => t.target)).toEqual(["t2", "t3", "t4"]);
    expect(plan.skipped).toEqual([{ target: "t8", reason: "back at its shell (the agent exited)" }]);
    expect(plan.command).toContain("'core:t2' 'core:t3' 'core:t4' '--stall' '600000'");
    expect(plan.command).not.toContain("t8");
    expect(plan.description).toBe("team under t2: t2, t3, t4");
  });

  it("an unknown target fails here, before anything is armed", async () => {
    expect((await failure(setup(plenary()).team.watch({ target: "t404" }))).code).toBe("not_found");
  });
});

describe("recycle", () => {
  it("starts the successor from the old member's own labels, flags, folder and tab label, re-points its reports and retires it", async () => {
    const s = setup(plenary(), { files: ["/repo/docs/handoff/manager.md"] });
    const result = await s.team.recycle({ target: "t2", handoff: "docs/handoff/manager.md" });
    expect(result).toMatchObject({ successor: { target: "t900", tabId: "tb-t900", tabLabel: "manager engine" }, retired: "t2", self: false, warnings: [] });
    expect(result.repointed).toEqual(["t3", "t4"]);
    const run = JSON.parse(s.calls[0]!.slice(4));
    expect(run.argv.slice(1 + CLAUDE_SESSION_MARKERS.length * 2)).toEqual([
      "claude", "--settings", "/s.json", "--plugin-dir", "/p/engram", "--plugin-dir", "/p/herderp", "--model", "opus",
      "Read docs/handoff/manager.md and continue as manager.",
    ]);
    expect(run.labels).toEqual({ "herdr.space": SPACE, plenary: "manager", "plenary.reports-to": "t1" });
    expect(s.calls.slice(1)).toEqual([
      `app tab.rename {"id":"tb-t900","name":"manager engine"}`,
      `label t3 {"reports-to":"t900"}`,
      `label t4 {"reports-to":"t900"}`,
      `label t2 {"retired":"t900"}`,
      `app tab.rename {"id":"tb2","name":"retired manager engine"}`,
    ]);
    expect(s.calls.some((c) => c.startsWith("kill"))).toBe(false);
  });

  it("defaults to the caller (the 60% self hand-off) and moves the lead: successor labelled at start, then the old one unlabelled", async () => {
    const world = plenary();
    world.terminals[0]!.labels["herdr.tab"] = "tb1";
    world.terminals[0]!.labels.where = "plenary / ★ proxy";
    const s = setup(world, { files: ["/abs/handoff.md"] });
    const result = await s.team.recycle({ handoff: "/abs/handoff.md", prompt: "Take over." });
    expect(result.self).toBe(true);
    const run = JSON.parse(s.calls[0]!.slice(4));
    expect(run.labels).toEqual({ "herdr.space": SPACE, role: "orchestrator", plenary: "proxy" });
    expect(run.argv.at(-1)).toBe("Take over.");
    expect(s.calls).toContain(`label t1 {"retired":"t900","role":""}`);
    expect(s.calls).toContain(`label t2 {"plenary.reports-to":"t900"}`);
  });

  it("touches nothing when the hand-off file is missing or the successor does not start", async () => {
    const missing = setup(plenary());
    expect((await failure(missing.team.recycle({ target: "t2", handoff: "nope.md" }))).code).toBe("no_handoff");
    expect(missing.calls).toEqual([]);
    const dead = setup(plenary(), { files: ["/repo/h.md"], core: { terminalRun: async () => { throw new CoreError("spawn_failed", "no claude"); } } });
    expect((await failure(dead.team.recycle({ target: "t2", handoff: "h.md" }))).code).toBe("spawn_failed");
    expect(dead.calls).toEqual([]);
  });

  it("after the successor is up, a failed label is a warning and the successor is still returned", async () => {
    const s = setup(plenary(), { files: ["/repo/h.md"], core: { terminalLabel: async () => { throw new CoreError("timeout", "core busy"); } } });
    const result = await s.team.recycle({ target: "t2", handoff: "h.md" });
    expect(result.successor.target).toBe("t900");
    expect(result.repointed).toEqual([]);
    expect(result.warnings).toEqual([
      "t3 still reports to t2: core busy",
      "t4 still reports to t2: core busy",
      "t2 was not labelled retired: core busy",
    ]);
  });

  it("refuses an already-retired member, a remote one, a non-Claude one, and one in no space", async () => {
    const world = plenary();
    world.terminals.push(terminal("ska/t9", { machine: "ska" }), terminal("t10", { argv: ["codex", "go"] }), terminal("t11", { labels: { "herdr.space": "" } }));
    const s = setup(world, { files: ["/repo/h.md"] });
    expect((await failure(s.team.recycle({ target: "t4", handoff: "h.md" }))).code).toBe("already_retired");
    expect((await failure(s.team.recycle({ target: "ska/t9", handoff: "h.md" }))).code).toBe("unsupported_remote");
    expect((await failure(s.team.recycle({ target: "t10", handoff: "h.md" }))).code).toBe("unsupported_agent");
    expect((await failure(s.team.recycle({ target: "t11", handoff: "h.md" }))).code).toBe("not_a_member");
    expect(s.calls).toEqual([]);
  });
});

describe("cleanup", () => {
  it("by default closes only retired members of this space: tab, then kill, then remove, and checks they are gone", async () => {
    const s = setup(plenary());
    const result = await s.team.cleanup({});
    expect(result).toEqual({ dryRun: false, closed: [{ target: "t4", tabClosed: true, gone: true }], skipped: [] });
    expect(s.calls).toEqual([`app tab.close {"id":"tb4","confirmed":true}`, "kill t4", "rm t4"]);
  });

  it("status done is never a reason: a done worker is untouched until it is named", async () => {
    const world = plenary();
    world.terminals.find((t) => t.address === "t4")!.labels = { "herdr.space": SPACE, job: "p1v", "reports-to": "t2" };
    const s = setup(world);
    expect((await s.team.cleanup({})).closed).toEqual([]);
    expect(s.calls).toEqual([]);
    expect((await s.team.cleanup({ targets: ["t4"] })).closed).toEqual([{ target: "t4", tabClosed: true, gone: true }]);
  });

  it("guards every named target: you, other spaces, non-members, members with reports, working members, unknown ids", async () => {
    const world = plenary();
    world.terminals.find((t) => t.address === "t3")!.status = "working";
    const s = setup(world);
    const result = await s.team.cleanup({ targets: ["t1", "t6", "t5", "t2", "t3", "t404"] });
    expect(result.closed).toEqual([]);
    expect(Object.fromEntries(result.skipped.map((r) => [r.target, r.reason.split(" - ")[0]]))).toEqual({
      t404: "no such terminal (already removed?)",
      t1: "that is you",
      t6: `not in space "plenary"`,
      t5: "not a team member (no reports-to, job or retired label)",
      t2: "still has reports (t3, t4)",
      t3: "still working",
    });
    expect(s.calls).toEqual([]);
  });

  it("force ends a working member; a parent goes when its reports go in the same call", async () => {
    const world = plenary();
    world.terminals.find((t) => t.address === "t3")!.status = "working";
    const s = setup(world);
    const result = await s.team.cleanup({ targets: ["t2", "t3", "t4"], force: true });
    expect(result.closed.map((r) => r.target)).toEqual(["t2", "t3", "t4"]);
    expect(result.skipped).toEqual([]);
  });

  it("never closes a tab the member shares; ends only its terminal", async () => {
    const world = plenary();
    world.terminals.find((t) => t.address === "t5")!.labels = { "herdr.space": SPACE, job: "side", "reports-to": "t1" };
    const s = setup(world);
    const result = await s.team.cleanup({ targets: ["t5"] });
    expect(result.closed).toEqual([{ target: "t5", tabClosed: false, gone: true }]);
    expect(s.calls).toEqual(["kill t5", "rm t5"]);
  });

  it("dryRun changes nothing and lists what would close", async () => {
    const s = setup(plenary());
    const result = await s.team.cleanup({ dryRun: true });
    expect(result).toEqual({ dryRun: true, closed: [{ target: "t4", tabClosed: true, gone: null }], skipped: [] });
    expect(s.calls).toEqual([]);
  });

  it("steps that find their work already done are tolerated; a terminal still listed is reported as not gone", async () => {
    const s = setup(plenary(), {
      core: {
        terminalKill: async () => { throw new CoreError("finished", "already ended"); },
        terminalRm: async () => { throw new CoreError("not_finished", "still live"); },
      },
    });
    expect((await s.team.cleanup({})).closed).toEqual([{ target: "t4", tabClosed: true, gone: false }]);
  });

  it("also picks up team terminals whose program has ended", async () => {
    const world = plenary();
    world.terminals.push(terminal("t12", { state: "finished", labels: { job: "old", "reports-to": "t2" }, foreground: null }));
    const result = await setup(world).team.cleanup({});
    expect(result.closed.map((r) => r.target)).toEqual(["t4", "t12"]);
  });
});
