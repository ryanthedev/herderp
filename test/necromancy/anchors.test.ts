// Unit tests for the deterministic anchor extractor (src/necromancy/anchors.ts).
//
// The centerpiece is a PLANTED-NEEDLE fixture: a synthetic session with a set
// of known load-bearing facts deliberately baked in (a decision, a file, an
// error, a commit + SHA, a PR, a version bump, a test result). The extractor
// must grab every planted needle - that's the "make sure we aren't missing
// anything" guarantee. Plus the never-crash discipline (empty, malformed,
// noise-only) and the bounds (dedupe + per-category cap).

import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { extractAnchors, MAX_ANCHORS_PER_CATEGORY, userIntent, type AnchorItem } from "../../src/necromancy/anchors.js";
import { registerNecromancyTools } from "../../src/tools/necromancy.js";
import { createNecromancy, deriveSlug, type Necromancy, type Turn } from "../../src/necromancy/core.js";
import type { HerdrClient } from "../../src/herdr/client.js";

/** Just the texts of an anchor list, for content assertions. */
const texts = (items: AnchorItem[]): string[] => items.map((item) => item.text);

/** Turn[] builder: assigns sequential indexes so tests read as plain content. */
function turns(...specs: Array<Omit<Turn, "index">>): Turn[] {
  return specs.map((spec, index) => ({ ...spec, index }));
}

// The planted needles - each string here is a fact the extractor MUST surface.
const PLANTED = turns(
  { role: "user", text: "please fix the flaky login test and cut a release" },
  { role: "thinking", text: "let me look at the reader first" },
  { role: "tool_use", tool: "Edit", text: '{"file_path":"src/necromancy/reader.ts","old_string":"a","new_string":"b"}' },
  { role: "tool_result", tool: "Bash", text: "Error: ENOENT: no such file or directory, open 'nope.ts'" },
  { role: "user", text: "actually, let's rename the module to sessionReader instead" },
  { role: "text", text: "Committing: git commit -m 'feat(necromancy): add anchors' at commit a1b2c3d4" },
  { role: "text", text: "Opened PR #42 and bumped to 0.4.0" },
  { role: "tool_result", tool: "Bash", text: "135 pass, 0 fail. Ran 140 tests across 9 files." },
  { role: "text", text: "All landed and clean." },
);

describe("extractAnchors - planted needles", () => {
  const a = extractAnchors(PLANTED);

  it("grabs the ask (first user turn)", () => {
    expect(a.ask).toEqual({ text: "please fix the flaky login test and cut a release", index: 0 });
  });

  it("grabs the last state (last assistant text)", () => {
    expect(a.lastState).toEqual({ text: "All landed and clean.", index: 8 });
  });

  it("grabs the file touched via the tool_use file_path field", () => {
    expect(a.files).toContainEqual({ text: "src/necromancy/reader.ts", index: 2 });
  });

  it("grabs the error signal", () => {
    expect(texts(a.errors).some((e) => e.includes("ENOENT"))).toBe(true);
  });

  it("grabs the git op, the conventional-commit subject, and the SHA", () => {
    expect(texts(a.commits).some((c) => c.startsWith("git commit"))).toBe(true);
    expect(texts(a.commits).some((c) => c.startsWith("feat(necromancy):"))).toBe(true);
    expect(a.commits).toContainEqual({ text: "a1b2c3d4", index: 5 });
  });

  it("grabs the PR number", () => {
    expect(a.prs).toContainEqual({ text: "42", index: 6 });
  });

  it("grabs the version bump", () => {
    expect(texts(a.versions)).toContain("0.4.0");
  });

  it("grabs the test-result line", () => {
    expect(texts(a.tests).some((t) => t.includes("135 pass"))).toBe(true);
  });

  it("reports nothing omitted when no category overflowed", () => {
    expect(a.omitted).toEqual({});
  });

  it("grabs the user decision/pivot", () => {
    expect(texts(a.decisions).some((d) => d.includes("rename the module"))).toBe(true);
  });
});

describe("extractAnchors - never crashes, always bounded", () => {
  it("returns empty anchors on no turns", () => {
    const a = extractAnchors([]);
    expect(a.ask).toBeNull();
    expect(a.lastState).toBeNull();
    expect(a.commits).toEqual([]);
  });

  it("survives noise-only and whitespace turns without inventing anchors", () => {
    const a = extractAnchors(turns({ role: "text", text: "   " }, { role: "user", text: "" }));
    expect(a.ask).toBeNull();
    expect(a.files).toEqual([]);
    expect(a.errors).toEqual([]);
  });

  it("dedupes and caps each category at MAX_ANCHORS_PER_CATEGORY", () => {
    const many = turns(
      ...Array.from({ length: 40 }, (_, i) => ({ role: "text" as const, text: `merged PR #${i}` })),
      ...Array.from({ length: 5 }, () => ({ role: "text" as const, text: "merged PR #7" })), // dupes
    );
    const a = extractAnchors(many);
    expect(a.prs.length).toBe(MAX_ANCHORS_PER_CATEGORY);
    expect(new Set(texts(a.prs)).size).toBe(a.prs.length); // no dupes survived
  });

  it("keeps the NEWEST items when a category overflows, and counts what it dropped", () => {
    const many = turns(...Array.from({ length: 30 }, (_, i) => ({ role: "text" as const, text: `merged PR #${i}` })));
    const a = extractAnchors(many);
    // The last 12 PRs (18..29) survive in chronological order; the oldest 18 are reported, not silently cut.
    expect(texts(a.prs)).toEqual(Array.from({ length: MAX_ANCHORS_PER_CATEGORY }, (_, i) => String(18 + i)));
    expect(a.prs.at(-1)).toEqual({ text: "29", index: 29 });
    expect(a.omitted).toEqual({ prs: 30 - MAX_ANCHORS_PER_CATEGORY });
  });

  it("moves a repeated item to its latest occurrence", () => {
    const a = extractAnchors(
      turns({ role: "text", text: "see PR #5" }, { role: "text", text: "see PR #6" }, { role: "text", text: "merged PR #5" }),
    );
    expect(a.prs).toEqual([
      { text: "6", index: 1 },
      { text: "5", index: 2 },
    ]);
  });

  it("falls back to the last turn for lastState when there is no assistant text", () => {
    const a = extractAnchors(turns({ role: "user", text: "only a user turn" }));
    expect(a.lastState).toEqual({ text: "only a user turn", index: 0 });
  });
});

describe("extractAnchors - harness boilerplate is not the user's intent", () => {
  it("skips a local-command caveat when picking the ask and decisions", () => {
    const a = extractAnchors(
      turns(
        { role: "user", text: "<local-command-caveat>Caveat: DO NOT respond to these messages</local-command-caveat>" },
        { role: "user", text: "catch me up on the login work" },
      ),
    );
    expect(a.ask).toEqual({ text: "catch me up on the login work", index: 1 });
    expect(a.decisions).toEqual([]);
  });

  it("reads a slash-command record back as the command line", () => {
    const a = extractAnchors(
      turns({
        role: "user",
        text: "<command-message>herderp:ghost</command-message>\n<command-name>/herderp:ghost</command-name>\n<command-args>upublish:1</command-args>",
      }),
    );
    expect(a.ask?.text).toBe("/herderp:ghost upublish:1");
  });

  it("userIntent returns null for system reminders and interruptions", () => {
    expect(userIntent("<system-reminder>ctx</system-reminder>")).toBeNull();
    expect(userIntent("[Request interrupted by user]")).toBeNull();
    expect(userIntent("   ")).toBeNull();
    expect(userIntent("ship it")).toBe("ship it");
  });

  it("does not harvest versions from tool_result output (dependency dumps)", () => {
    const a = extractAnchors(
      turns(
        { role: "tool_result", tool: "Bash", text: "zod@3.25.0 typescript@5.7.0 react@18.3.1" },
        { role: "text", text: "bumped herderp to 0.12.0" },
      ),
    );
    expect(texts(a.versions)).toEqual(["0.12.0"]);
  });
});

// ---------------------------------------------------------------------------
// necromancy_anchors tool - registered + end-to-end over a planted fixture
// ---------------------------------------------------------------------------

function registeredTools(server: McpServer) {
  return (server as unknown as {
    _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> }>;
  })._registeredTools;
}

function stubClient(): HerdrClient {
  const unexpected = (name: string) => async () => {
    throw new Error(`unexpected herdr call: ${name}`);
  };
  return {
    agentList: unexpected("agentList"),
    agentGet: unexpected("agentGet"),
    agentRead: unexpected("agentRead"),
    agentWait: unexpected("agentWait"),
    workspaceList: unexpected("workspaceList"),
    workspaceCreate: unexpected("workspaceCreate"),
    workspaceFocus: unexpected("workspaceFocus"),
    paneRun: unexpected("paneRun"),
    paneClose: unexpected("paneClose"),
    sessionList: unexpected("sessionList"),
    tabList: unexpected("tabList"),
    paneList: unexpected("paneList"),
  } as unknown as HerdrClient;
}

describe("necromancy_anchors tool integration (real core, real registry)", () => {
  const CWD = "/tmp/necromancy-anchors-proj";
  const SESSION_ID = "11111111-1111-1111-1111-111111111111";

  it("extracts planted anchors end to end via the registered tool", async () => {
    const root = await mkdtemp(join(tmpdir(), "necromancy-anchors-test-"));
    try {
      const dir = join(root, deriveSlug(CWD));
      await mkdir(dir, { recursive: true });
      const jl = (v: unknown): string => `${JSON.stringify(v)}\n`;
      const content =
        jl({ type: "user", message: { content: "ship the anchors feature" }, cwd: CWD }) +
        jl({
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", id: "c1", name: "Write", input: { file_path: "src/necromancy/anchors.ts", content: "x" } },
              { type: "text", text: "merged PR #99, bumped to 0.4.0, 135 pass 0 fail" },
            ],
          },
        });
      await writeFile(join(dir, `${SESSION_ID}.jsonl`), content);

      const server = new McpServer({ name: "test", version: "0.0.0" });
      const necromancy: Necromancy = createNecromancy({ client: stubClient(), projectsRoot: root });
      registerNecromancyTools(server, necromancy);
      const tools = registeredTools(server);

      expect(tools.necromancy_anchors).toBeDefined();

      const result = await tools.necromancy_anchors!.handler({ sessionId: SESSION_ID, cwd: CWD }, {});
      expect(result.isError).toBeFalsy();
      const anchors = JSON.parse(result.content[0]!.text);
      expect(anchors.ask.text).toBe("ship the anchors feature");
      expect(texts(anchors.files)).toContain("src/necromancy/anchors.ts");
      expect(texts(anchors.prs)).toContain("99");
      expect(texts(anchors.versions)).toContain("0.4.0");
      expect(texts(anchors.tests).some((t) => t.includes("135 pass"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("surfaces a non-UUID sessionId as isError, not a crash", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const necromancy: Necromancy = createNecromancy({ client: stubClient(), projectsRoot: "/tmp/does-not-matter" });
    registerNecromancyTools(server, necromancy);

    const result = await registeredTools(server).necromancy_anchors!.handler({ sessionId: "not-a-uuid", cwd: CWD }, {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("not a UUID");
  });
});
