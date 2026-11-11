// Tests for the pure team rules (src/team/roster.ts): label reading, screen
// heuristics against text copied from live panes, flags, and the tree.

import { describe, expect, it } from "bun:test";
import {
  buildRoster,
  carriedFlags,
  endsWithQuestion,
  extractFlags,
  loginLaunch,
  hasTeamLabel,
  jobOf,
  parseBlockedPrompt,
  parseContextPct,
  parseDraft,
  reportsToKey,
  reportsToOf,
  stripEnvWrapper,
  subtreeOf,
  type MemberFacts,
} from "../../src/team/roster.js";

const RULE = "─".repeat(120);

/** Copied from `hc read t14h` (Claude Code 2.1.322), 2026-11-11: working, empty composer. */
const RAW_SCREEN_WORKING = `⏺ Both stopped, so I'm rewriting drive.js.

✶ Perambulating… (9s · ↓ 823 tokens)

${RULE}
❯
${RULE}
  \uf2db Opus 5.5 · \uf0e7 medium · \uf0e4 16%
  -- INSERT -- ⏵⏵ auto mode on · 1 monitor`;

const screenWith = (composer: string, pct = 61) => `⏺ Done.

${RULE}
${composer}
${RULE}
  \uf2db Fable 5.2 · \uf0e7 medium · \uf0e4 ${pct}%
  -- INSERT -- ⏵⏵ auto mode on (shift+tab to cycle)`;

/** Copied from `hc read t10v`, 2026-11-11: a blocked pane asking yes/no. */
const RAW_SCREEN_PERMISSION = `Migrate the settings page

● Edited app/settings/page.tsx

Allow  rm -rf .next ?
  1. Yes
  2. No`;

describe("labels", () => {
  it("reads reports-to, and the hand-made <project>.reports-to form", () => {
    expect(reportsToOf({ "reports-to": "t1" })).toBe("t1");
    expect(reportsToKey({ plenary: "p6", "plenary.reports-to": "t14k" })).toBe("plenary.reports-to");
    expect(reportsToOf({ plenary: "p6", "plenary.reports-to": "t14k" })).toBe("t14k");
    expect(reportsToOf({ "reports-to": "t1", "plenary.reports-to": "t2" })).toBe("t1");
    expect(reportsToOf({ role: "orchestrator" })).toBeNull();
  });

  it("reads job, and the hand-made <project>=<job> beside <project>.reports-to", () => {
    expect(jobOf({ job: "p1" })).toBe("p1");
    expect(jobOf({ plenary: "p6-base", "plenary.reports-to": "t14k" })).toBe("p6-base");
    expect(jobOf({ plenary: "proxy" })).toBeNull();
  });

  it("a team label is reports-to, job or retired - a space label alone is not one", () => {
    expect(hasTeamLabel({ "herdr.space": "sp1" })).toBe(false);
    expect(hasTeamLabel({ "herderp.reports-to": "t13s" })).toBe(true);
    expect(hasTeamLabel({ job: "x" })).toBe(true);
    expect(hasTeamLabel({ retired: "t9" })).toBe(true);
  });
});

describe("screen heuristics", () => {
  it("reads context use from the pane footer", () => {
    expect(parseContextPct(RAW_SCREEN_WORKING)).toBe(16);
    expect(parseContextPct(screenWith("❯ ", 100))).toBe(100);
    expect(parseContextPct("just a shell\n$ ls\n")).toBeNull();
    expect(parseContextPct("progress · 250%")).toBeNull();
    expect(parseContextPct("   Opus 5.5 ·  medium ·  9%")).toBe(9); // without icon glyphs
  });

  it("an empty composer is no draft; typed text is, across lines", () => {
    expect(parseDraft(RAW_SCREEN_WORKING)).toBeNull();
    expect(parseDraft(screenWith("❯ ship it when green"))).toBe("ship it when green");
    expect(parseDraft(screenWith("❯\u00a0tell the engine manager the report is ready"))).toBe("tell the engine manager the report is ready");
    expect(parseDraft(screenWith("❯ first line\n  second line"))).toBe("first line\nsecond line");
    expect(parseDraft("no composer here")).toBeNull();
  });

  it("finds a permission prompt and keeps the command above its choices", () => {
    const prompt = parseBlockedPrompt(RAW_SCREEN_PERMISSION);
    expect(prompt.permission).toBe(true);
    expect(prompt.detail).toContain("Allow  rm -rf .next ?");
    expect(prompt.detail).not.toContain("1. Yes");
  });

  it("without a yes/no list, a blocked screen is not called a permission prompt", () => {
    expect(parseBlockedPrompt("Which database?\n  ❯ postgres\n    sqlite")).toMatchObject({ permission: false });
  });

  it("a reply ending in a question mark is a question", () => {
    expect(endsWithQuestion("I did X.\nShould I also do Y?")).toBe(true);
    expect(endsWithQuestion("Should I do Y? I went ahead.")).toBe(false);
    expect(endsWithQuestion("**Proceed?**")).toBe(true);
    expect(endsWithQuestion(null)).toBe(false);
  });
});

function facts(target: string, over: Partial<MemberFacts> = {}): MemberFacts {
  return {
    target, labels: {}, status: "working", blockedKind: null, message: "", createdMs: Number(target.replace(/\D/g, "")),
    tabId: `tb-${target}`, tabLabel: `tab ${target}`, screen: RAW_SCREEN_WORKING, lastReply: null, activityAt: null, ...over,
  };
}
const NOW = 10_000_000;
const live = (...ids: string[]) => new Set(ids);

describe("buildRoster", () => {
  it("builds the tree by reports-to with the orchestrator on top, as plenary ran it", () => {
    const roster = buildRoster(
      [
        facts("t3", { labels: { plenary: "manager-client", "plenary.reports-to": "t2" } }),
        facts("t4", { labels: { job: "p6-base", "reports-to": "t3" } }),
        facts("t1", { labels: { plenary: "owner", role: "owner" } }),
        facts("t2", { labels: { plenary: "proxy", role: "orchestrator" } }),
      ],
      { now: NOW, live: live("t1", "t2", "t3", "t4"), you: "t4" },
    );
    expect(roster.leader).toBe("t2");
    expect(roster.tree.map((m) => m.target)).toEqual(["t2", "t1"]);
    const manager = roster.tree[0]!.reports[0]!;
    expect(manager).toMatchObject({ target: "t3", job: "manager-client", reportsTo: "t2", contextPct: 16 });
    expect(manager.reports[0]).toMatchObject({ target: "t4", job: "p6-base", you: true });
    expect(roster.warnings).toEqual([]);
  });

  it("a member reporting outside the space is a root marked outside; one whose parent is gone is an orphan", () => {
    const roster = buildRoster(
      [facts("t154", { labels: { "herderp.reports-to": "t13s" } }), facts("t9", { labels: { "reports-to": "t0" } })],
      { now: NOW, live: live("t154", "t9", "t13s") },
    );
    expect(roster.tree.map((m) => [m.target, m.reportsToOutside, m.flags])).toEqual([
      ["t9", false, ["orphan"]],
      ["t154", true, []],
    ]);
    expect(roster.leader).toBeNull();
    expect(roster.attention).toEqual([]);
  });

  it("role=proxy is infrastructure: out of the tree, never the leader", () => {
    const roster = buildRoster([facts("t5", { labels: { role: "proxy" } }), facts("t6")], { now: NOW, live: live("t5", "t6") });
    expect(roster.tree.map((m) => m.target)).toEqual(["t6"]);
    expect(roster.infrastructure.map((m) => m.target)).toEqual(["t5"]);
  });

  it("two orchestrators: the oldest leads, with a warning; a retired one does not count", () => {
    const two = buildRoster([facts("t8", { labels: { role: "orchestrator" } }), facts("t2", { labels: { role: "orchestrator" } })], { now: NOW, live: live("t2", "t8") });
    expect(two.leader).toBe("t2");
    expect(two.warnings[0]).toContain("more than one role=orchestrator");
    const handedOff = buildRoster(
      [facts("t2", { labels: { role: "orchestrator", retired: "t8" } }), facts("t8", { labels: { role: "orchestrator" } })],
      { now: NOW, live: live("t2", "t8") },
    );
    expect(handedOff.leader).toBe("t8");
    expect(handedOff.warnings).toEqual([]);
  });

  it("a reports-to loop does not hang or drop anyone", () => {
    const roster = buildRoster(
      [facts("t1", { labels: { "reports-to": "t2" } }), facts("t2", { labels: { "reports-to": "t1" } }), facts("t3", { labels: { "reports-to": "t3" } })],
      { now: NOW, live: live("t1", "t2", "t3") },
    );
    expect(roster.tree.map((m) => m.target).sort()).toEqual(["t1", "t2", "t3"]);
    expect(roster.warnings.length).toBe(3); // both ends of the pair, and the self-report
  });

  it("attention lists who needs a look, worst first, with the detail to act on", () => {
    const roster = buildRoster(
      [
        facts("t1", { status: "done", lastReply: "Built it.\nShould I push?" }),
        facts("t2", { status: "blocked", screen: RAW_SCREEN_PERMISSION }),
        facts("t3", { status: "working", screen: screenWith("❯ dont forget the tests", 12) }),
        facts("t8", { status: "done", screen: screenWith("❯ keep the train moving", 12) }), // a stopped pane's composer may be a suggestion
        facts("t4", { status: "working", activityAt: NOW - 700_000 }),
        facts("t5", { status: "working", screen: screenWith("❯ ", 60), activityAt: NOW - 1000 }),
        facts("t6", { status: "blocked", blockedKind: "auth", screen: "Login required" }),
        facts("t7", { status: "done", lastReply: "All done." }),
      ],
      { now: NOW, live: live() },
    );
    expect(roster.attention.map((a) => [a.target, a.flags])).toEqual([
      ["t2", ["permission"]],
      ["t6", ["blocked"]],
      ["t1", ["question"]],
      ["t3", ["draft"]],
      ["t4", ["stalled"]],
      ["t5", ["context"]],
    ]);
    expect(roster.attention[0]!.detail).toContain("rm -rf .next");
    expect(roster.attention[2]!.detail).toContain("Should I push?");
    expect(roster.attention[3]!.detail).toBe("dont forget the tests");
    expect(roster.attention[4]!.why).toContain("12 min");
    expect(roster.attention[1]!.why).toBe("blocked (auth)");
    expect(roster.tree.find((m) => m.target === "t8")).toMatchObject({ composer: "keep the train moving", flags: [] });
  });

  it("an unreadable screen leaves contextPct null and raises no screen flags", () => {
    const roster = buildRoster([facts("t1", { status: "blocked", screen: null })], { now: NOW, live: live() });
    expect(roster.tree[0]).toMatchObject({ contextPct: null, flags: ["blocked"] });
  });

  it("stallMs moves the stalled line; a long last reply is cut to 300 chars", () => {
    const f = [facts("t1", { status: "working", activityAt: NOW - 90_000, lastReply: "x".repeat(900) })];
    expect(buildRoster(f, { now: NOW, live: live() }).tree[0]!.flags).toEqual([]);
    const tight = buildRoster(f, { now: NOW, live: live(), stallMs: 60_000 }).tree[0]!;
    expect(tight.flags).toEqual(["stalled"]);
    expect(tight.lastMessage!.length).toBe(300);
  });
});

describe("subtreeOf", () => {
  it("returns the member and everyone under it, root first, walking a loop once", () => {
    const members: Array<{ target: string; labels: Record<string, string> }> = [
      { target: "t1", labels: {} },
      { target: "t2", labels: { "reports-to": "t1" } },
      { target: "t3", labels: { "x.reports-to": "t2" } },
      { target: "t4", labels: { "reports-to": "t9" } },
      { target: "t5", labels: { "reports-to": "t3" } },
    ];
    expect(subtreeOf(members, "t1")).toEqual(["t1", "t2", "t3", "t5"]);
    expect(subtreeOf(members, "t3")).toEqual(["t3", "t5"]);
    expect(subtreeOf([{ target: "a", labels: { "reports-to": "b" } }, { target: "b", labels: { "reports-to": "a" } }], "a")).toEqual(["a", "b"]);
  });
});

describe("launch lines", () => {
  /** Copied from `hc get t154`, 2026-11-11. */
  const RAW_ARGV = ["claude", "--settings", "/Users/r/.config/claude/settings.shared.json", "--plugin-dir", "/Users/r/repos/code-foundations", "--plugin-dir", "/Users/r/repos/herderp", "Read docs/briefs/team-tools.md and do it."];

  it("pulls the plugin set out of a launch line, through an env wrapper", () => {
    const flags = ["--settings", "/Users/r/.config/claude/settings.shared.json", "--plugin-dir", "/Users/r/repos/code-foundations", "--plugin-dir", "/Users/r/repos/herderp"];
    expect(extractFlags(RAW_ARGV)).toEqual(flags);
    expect(extractFlags(["env", "-u", "CLAUDECODE", "-u", "CLAUDE_PID", ...RAW_ARGV])).toEqual(flags);
    expect(extractFlags(["claude", "--plugin-dir=/a", "--model", "opus", "hi"])).toEqual(["--plugin-dir=/a"]);
    expect(extractFlags(["/bin/zsh", "-l"])).toEqual([]);
  });

  it("a successor also keeps how its predecessor ran, never the old prompt", () => {
    expect(carriedFlags(["claude", "--model", "opus", "--plugin-dir", "/a", "--dangerously-skip-permissions", "old prompt"])).toEqual([
      "--model", "opus", "--plugin-dir", "/a", "--dangerously-skip-permissions",
    ]);
  });

  it("loginLaunch runs the line through zsh or bash as a login + interactive shell that becomes the program", () => {
    expect(loginLaunch(["env", "-u", "A", "claude", "go"], "/bin/zsh")).toEqual(["/bin/zsh", "-lic", 'exec "$@"', "zsh", "env", "-u", "A", "claude", "go"]);
    expect(loginLaunch(["claude"], "/usr/local/bin/fish")).toEqual(["claude"]);
    expect(loginLaunch(["claude"], undefined)).toEqual(["claude"]);
    expect(stripEnvWrapper(loginLaunch(["env", "-u", "A", "claude", "go"], "/opt/homebrew/bin/bash"))).toEqual(["claude", "go"]);
    expect(carriedFlags(loginLaunch(["env", "-u", "A", "claude", "--model", "opus", "go"], "/bin/zsh"))).toEqual(["--model", "opus"]);
  });

  it("stripEnvWrapper leaves a plain line alone", () => {
    expect(stripEnvWrapper(["claude", "x"])).toEqual(["claude", "x"]);
    expect(stripEnvWrapper(["env", "A=1", "-u", "B", "claude"])).toEqual(["claude"]);
  });
});
