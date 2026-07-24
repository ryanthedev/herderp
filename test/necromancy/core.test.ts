// Unit tests for the necromancy core (src/necromancy/core.ts) - DW-3.1
// through DW-3.5 / DW-3.7. All FS access goes through a per-test temp
// fixture dir injected as projectsRoot (never the real ~/.claude/projects);
// all herdr access goes through a stub HerdrClient (never a live herdr).

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createNecromancy,
  deriveSlug,
  NecromancyError,
  type NecromancyOptions,
} from "../../src/necromancy/core.js";
import { createHerdrClient, type HerdrClient, type HerdrRunner } from "../../src/herdr/client.js";
import { HerdrError, type Agent, type Pane, type Tab, type Workspace } from "../../src/herdr/types.js";

const U1 = "11111111-1111-1111-1111-111111111111";
const U2 = "22222222-2222-2222-2222-222222222222";
const U3 = "33333333-3333-3333-3333-333333333333";

const jl = (value: unknown): string => `${JSON.stringify(value)}\n`;

/** Minimal valid session content: one summary + one user line carrying cwd. */
function sessionContent(summary: string, cwd: string): string {
  return jl({ type: "summary", summary }) + jl({ type: "user", message: { content: "hi" }, cwd });
}

function stubAgent(sessionId: string, workspaceId = "w1", paneId = "w1:p1"): Agent {
  return { agent: "claude", sessionId, status: "working", cwd: "/tmp/proj", workspaceId, tabId: `${workspaceId}:t1`, paneId };
}

function stubWorkspace(id: string, cwd: string, label: string | null = null): Workspace {
  return { id, label, cwd, tabCount: 1, paneCount: 1 };
}

/** Stub client whose unstubbed methods fail loudly if reached. */
function stubClient(overrides: Partial<HerdrClient> = {}): HerdrClient {
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
    ...overrides,
  } as unknown as HerdrClient;
}

/** Every method records its name and throws - for zero-herdr-call assertions. */
function trackingClient(): { client: HerdrClient; calls: string[] } {
  const calls: string[] = [];
  const track = (name: string) => async () => {
    calls.push(name);
    throw new Error(`herdr must not be reached: ${name}`);
  };
  const client = {
    agentList: track("agentList"),
    agentGet: track("agentGet"),
    agentRead: track("agentRead"),
    agentWait: track("agentWait"),
    workspaceList: track("workspaceList"),
    workspaceCreate: track("workspaceCreate"),
    workspaceFocus: track("workspaceFocus"),
    paneRun: track("paneRun"),
    paneClose: track("paneClose"),
    sessionList: track("sessionList"),
    tabList: track("tabList"),
    paneList: track("paneList"),
  } as unknown as HerdrClient;
  return { client, calls };
}

describe("deriveSlug - DW-3.1", () => {
  it("DW_3_1_derives_the_verified_necrotest_slug", () => {
    expect(deriveSlug("/Users/r/repos/herderp/.necrotest")).toBe("-Users-r-repos-herderp--necrotest");
  });

  it("DW_3_1_slug_handles_hidden_dotted_and_multidot_paths", () => {
    expect(deriveSlug("/Users/r/repos/my.app")).toBe("-Users-r-repos-my-app");
    expect(deriveSlug("/a/.hidden/.b.c")).toBe("-a--hidden--b-c");
    expect(deriveSlug("/a/b.c.d/e")).toBe("-a-b-c-d-e");
  });

  it("DW_3_1_slug_preserves_literal_dashes_and_maps_trailing_slashes", () => {
    expect(deriveSlug("/a/my-proj.v2")).toBe("-a-my-proj-v2");
    expect(deriveSlug("/a/b/")).toBe("-a-b-");
    expect(deriveSlug("")).toBe("");
  });

  it("DW_3_1_slug_maps_at_underscore_and_other_punctuation_to_dash", () => {
    // Claude Code replaces every non-alphanumeric char, not just `/` and `.`.
    expect(deriveSlug("/Users/r/@acme/pkg")).toBe("-Users-r--acme-pkg");
    expect(deriveSlug("/a/my_proj")).toBe("-a-my-proj");
    expect(deriveSlug("/a/prod-_x")).toBe("-a-prod--x"); // no collapsing of adjacent dashes
    expect(deriveSlug("/a/b (1)/c")).toBe("-a-b--1--c");
  });
});

describe("necromancy core (fixture FS + stub client)", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "necromancy-test-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function makeSpace(cwd: string): Promise<string> {
    const dir = join(root, deriveSlug(cwd));
    await mkdir(dir, { recursive: true });
    return dir;
  }

  async function writeSession(dir: string, id: string, content: string, mtime?: Date): Promise<void> {
    const path = join(dir, `${id}.jsonl`);
    await writeFile(path, content);
    if (mtime) await utimes(path, mtime, mtime);
  }

  function necromancy(overrides: Partial<NecromancyOptions> & Pick<NecromancyOptions, "client">) {
    return createNecromancy({ projectsRoot: root, ...overrides });
  }

  describe("findSpaces - DW-3.2", () => {
    it("DW_3_2_findSpaces_joins_disk_and_live_workspaces", async () => {
      const cwdA = "/tmp/proj-a";
      const cwdB = "/tmp/proj-b";
      const dirA = await makeSpace(cwdA);
      const dirB = await makeSpace(cwdB);
      await writeSession(dirA, U1, sessionContent("older", cwdA), new Date("2026-07-01T00:00:00Z"));
      await writeSession(dirA, U2, sessionContent("newer", cwdA), new Date("2026-07-08T00:00:00Z"));
      await writeSession(dirB, U3, sessionContent("solo", cwdB), new Date("2026-07-05T00:00:00Z"));

      const core = necromancy({
        client: stubClient({ workspaceList: async () => [stubWorkspace("w1", cwdA, "alpha")] }),
      });
      const { spaces } = await core.findSpaces();

      expect(spaces).toHaveLength(2);
      const spaceA = spaces.find((s) => s.cwd === cwdA);
      expect(spaceA).toEqual({
        cwd: cwdA,
        label: "alpha",
        workspaceId: "w1",
        sessionCount: 2,
        lastActivity: new Date("2026-07-08T00:00:00Z").getTime(),
      });
      // Not live: cwd recovered from the session line's cwd field.
      const spaceB = spaces.find((s) => s.cwd === cwdB);
      expect(spaceB).toEqual({
        cwd: cwdB,
        label: null,
        workspaceId: null,
        sessionCount: 1,
        lastActivity: new Date("2026-07-05T00:00:00Z").getTime(),
      });
    });

    it("findSpaces_caps_to_limit_newest_first_and_reports_total_and_truncated", async () => {
      // Three spaces with distinct activity times; a limit of 2 returns the two
      // newest and flags that more matched (the token-cap guard).
      const cwdOld = "/tmp/proj-old";
      const cwdMid = "/tmp/proj-mid";
      const cwdNew = "/tmp/proj-new";
      await writeSession(await makeSpace(cwdOld), U1, sessionContent("o", cwdOld), new Date("2026-07-01T00:00:00Z"));
      await writeSession(await makeSpace(cwdMid), U2, sessionContent("m", cwdMid), new Date("2026-07-05T00:00:00Z"));
      await writeSession(await makeSpace(cwdNew), U3, sessionContent("n", cwdNew), new Date("2026-07-09T00:00:00Z"));

      const core = necromancy({ client: stubClient({ workspaceList: async () => [] }) });
      const result = await core.findSpaces({ limit: 2 });

      expect(result.total).toBe(3);
      expect(result.truncated).toBe(true);
      expect(result.spaces.map((s) => s.cwd)).toEqual([cwdNew, cwdMid]);
    });

    it("findSpaces_query_narrows_case_insensitively_over_cwd_label_and_workspaceId", async () => {
      const cwdA = "/tmp/herderp";
      const cwdB = "/tmp/other-proj";
      await writeSession(await makeSpace(cwdA), U1, sessionContent("a", cwdA));
      await writeSession(await makeSpace(cwdB), U2, sessionContent("b", cwdB));

      const core = necromancy({ client: stubClient({ workspaceList: async () => [] }) });
      const result = await core.findSpaces({ query: "HERDERP" });

      expect(result.total).toBe(1);
      expect(result.truncated).toBe(false);
      expect(result.spaces.map((s) => s.cwd)).toEqual([cwdA]);
    });

    it("DW_3_2_findSpaces_space_with_no_sessions_degrades_to_the_raw_slug", async () => {
      await mkdir(join(root, "-tmp-empty-space"), { recursive: true });

      const core = necromancy({ client: stubClient({ workspaceList: async () => [] }) });
      const { spaces } = await core.findSpaces();

      expect(spaces).toEqual([
        { cwd: "-tmp-empty-space", label: null, workspaceId: null, sessionCount: 0, lastActivity: null },
      ]);
    });

    it("DW_3_2_missing_projects_root_returns_empty_no_crash", async () => {
      const core = createNecromancy({
        projectsRoot: join(root, "does-not-exist"),
        client: stubClient(), // any herdr call would throw "unexpected"
      });

      expect(await core.findSpaces()).toEqual({ spaces: [], total: 0, truncated: false });
    });

    it("DW_3_2_tolerates_empty_cwd_workspaces_and_duplicate_cwds_first_listed_wins", async () => {
      const cwd = "/tmp/proj-a";
      const dir = await makeSpace(cwd);
      await writeSession(dir, U1, sessionContent("s", cwd));

      const core = necromancy({
        client: stubClient({
          workspaceList: async () => [
            stubWorkspace("w0", ""), // paneless workspace - no join signal, must not crash
            stubWorkspace("w1", cwd, "first"),
            stubWorkspace("w2", cwd, "second"),
          ],
        }),
      });
      const { spaces } = await core.findSpaces();

      expect(spaces).toHaveLength(1);
      expect(spaces[0]!.workspaceId).toBe("w1");
      expect(spaces[0]!.label).toBe("first");
    });

    it("DW_4_4_findSpaces_surfaces_a_typed_HerdrError_when_herdr_is_unreachable", async () => {
      // Salvaged from the removed live e2e suite: with a real HerdrClient
      // over a down runner, findSpaces must surface a typed HerdrError (not a
      // raw crash) once the disk scan finds a space and reaches herdr.
      await makeSpace("/tmp/proj-a"); // a dir must exist so workspaceList is reached
      const herdrDownRunner: HerdrRunner = async () => {
        throw new Error("connect ECONNREFUSED /Users/r/.config/herdr/herdr.sock");
      };
      const core = createNecromancy({ projectsRoot: root, client: createHerdrClient(herdrDownRunner) });

      const error = await core.findSpaces().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(HerdrError);
      expect((error as HerdrError).code).toBe("spawn_failed");
      expect((error as HerdrError).message).toContain("herdr");
      expect((error as HerdrError).message).not.toContain("undefined is not a function");
    });
  });

  describe("listSessions - DW-3.3", () => {
    it("DW_3_3_ranks_by_mtime_desc_and_marks_live_vs_dead", async () => {
      const cwd = "/tmp/proj-a";
      const dir = await makeSpace(cwd);
      await writeSession(dir, U1, sessionContent("oldest", cwd), new Date("2026-07-01T00:00:00Z"));
      await writeSession(dir, U2, sessionContent("newest", cwd), new Date("2026-07-08T00:00:00Z"));
      await writeSession(dir, U3, sessionContent("middle", cwd), new Date("2026-07-05T00:00:00Z"));

      const core = necromancy({
        client: stubClient({
          agentList: async () => [stubAgent(U3)],
          workspaceList: async () => [],
          tabList: async () => [],
        }),
      });
      const { sessions } = await core.listSessions(cwd);

      expect(sessions.map((s) => s.id)).toEqual([U2, U3, U1]);
      expect(sessions.map((s) => s.live)).toEqual([false, true, false]);
      expect(sessions[0]).toEqual({
        id: U2,
        cwd,
        mtime: new Date("2026-07-08T00:00:00Z").getTime(),
        live: false,
        preview: "newest",
        messageCount: 1,
      });
    });

    it("DW_3_3_skips_malformed_empty_and_oversized_jsonl", async () => {
      const cwd = "/tmp/proj-a";
      const dir = await makeSpace(cwd);
      await writeSession(dir, U1, sessionContent("valid", cwd));
      await writeSession(dir, U2, ""); // empty: stat-gated, never read
      await writeSession(dir, U3, "not json\n{broken"); // malformed content
      // Oversized: VALID content over the injected cap - excluded by stat
      // alone, proving the gate fires before (instead of) any read.
      const big = "44444444-4444-4444-4444-444444444444";
      await writeSession(dir, big, jl({ type: "summary", summary: "x".repeat(500) }));

      const core = necromancy({
        maxSessionBytes: 200,
        client: stubClient({ agentList: async () => [], workspaceList: async () => [], tabList: async () => [] }),
      });
      const { sessions } = await core.listSessions(cwd);

      expect(sessions.map((s) => s.id)).toEqual([U1]);
    });

    it("DW_3_3_excludes_nested_subagents_dir_and_non_uuid_filenames", async () => {
      const cwd = "/tmp/proj-a";
      const dir = await makeSpace(cwd);
      await writeSession(dir, U1, sessionContent("real", cwd));
      const nested = join(dir, "subagents");
      await mkdir(nested, { recursive: true });
      await writeSession(nested, U2, sessionContent("subagent", cwd));
      await writeFile(join(dir, "notes.jsonl"), sessionContent("not a session", cwd));
      await writeFile(join(dir, `${U3}.txt`), sessionContent("wrong extension", cwd));

      const core = necromancy({
        client: stubClient({ agentList: async () => [], workspaceList: async () => [], tabList: async () => [] }),
      });
      const { sessions } = await core.listSessions(cwd);

      expect(sessions.map((s) => s.id)).toEqual([U1]);
    });

    it("DW_3_5_live_id_without_file_does_not_break_listSessions", async () => {
      const cwd = "/tmp/proj-a";
      const dir = await makeSpace(cwd);
      await writeSession(dir, U1, sessionContent("on disk", cwd));

      const core = necromancy({
        // U2 live in herdr, no file
        client: stubClient({ agentList: async () => [stubAgent(U2)], workspaceList: async () => [], tabList: async () => [] }),
      });
      const { sessions } = await core.listSessions(cwd);

      expect(sessions.map((s) => s.id)).toEqual([U1]); // disk is authoritative
      expect(sessions[0]!.live).toBe(false);
    });

    it("DW_3_3_unknown_space_returns_empty_without_touching_herdr", async () => {
      const { client, calls } = trackingClient();
      const core = necromancy({ client });

      expect(await core.listSessions("/no/such/space")).toEqual({ sessions: [], degraded: false });
      expect(calls).toEqual([]);
    });

    // Reverses the original DW-3.5 "loud" choice: a herdr outage must NOT hide
    // the on-disk graveyard that reading depends on. listSessions now degrades
    // (live all false, degraded:true) and still returns every on-disk session.
    it("a_herdr_outage_degrades_listSessions_instead_of_throwing", async () => {
      const cwd = "/tmp/proj-a";
      const dir = await makeSpace(cwd);
      await writeSession(dir, U1, sessionContent("s", cwd));

      const core = necromancy({
        client: stubClient({
          agentList: async () => {
            throw new HerdrError("spawn_failed", "herdr is down");
          },
        }),
      });
      const { sessions, degraded } = await core.listSessions(cwd);

      expect(degraded).toBe(true);
      expect(sessions.map((s) => s.id)).toEqual([U1]);
      expect(sessions[0]!.live).toBe(false);
      expect(sessions[0]!.handle).toBeUndefined();
    });

    it("a_non_herdr_fault_in_agentList_still_propagates_loud", async () => {
      const cwd = "/tmp/proj-a";
      const dir = await makeSpace(cwd);
      await writeSession(dir, U1, sessionContent("s", cwd));

      const core = necromancy({
        client: stubClient({
          agentList: async () => {
            throw new TypeError("bug, not a herdr outage");
          },
        }),
      });
      const err = await core.listSessions(cwd).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(TypeError);
    });

    it("enriches a live session with its herdr handle and flags the current one", async () => {
      const cwd = "/repos/upublish";
      const dir = await makeSpace(cwd);
      await writeSession(dir, U1, sessionContent("live one", cwd));

      const liveAgent: Agent = { agent: "claude", sessionId: U1, status: "working", cwd, workspaceId: "wC", tabId: "wC:t7", paneId: "wC:p8" };
      const core = necromancy({
        client: stubClient({
          agentList: async () => [liveAgent],
          workspaceList: async () => [stubWorkspace("wC", cwd, "upublish")],
          tabList: async () => [{ id: "wC:t7", workspaceId: "wC", label: "1", number: 7, focused: false }],
        }),
      });
      const { sessions, degraded } = await core.listSessions(cwd, { currentSessionId: U1 });

      expect(degraded).toBe(false);
      expect(sessions[0]!.live).toBe(true);
      expect(sessions[0]!.handle).toBe("upublish:1");
      expect(sessions[0]!.current).toBe(true);
    });

    it("omits handle/current for a non-live session and when no currentSessionId is given", async () => {
      const cwd = "/repos/upublish";
      const dir = await makeSpace(cwd);
      await writeSession(dir, U1, sessionContent("dead one", cwd));

      const core = necromancy({
        client: stubClient({ agentList: async () => [], workspaceList: async () => [], tabList: async () => [] }),
      });
      const { sessions } = await core.listSessions(cwd);

      expect(sessions[0]!.handle).toBeUndefined();
      expect(sessions[0]!.current).toBeUndefined();
    });
  });

  // searchAllSessions is the "I know WHAT happened, not WHERE" path: it never
  // takes a space to start from, so these fixtures deliberately hide the match
  // in a space the caller would not have guessed.
  describe("searchAllSessions - cross-session content search", () => {
    /** A session whose user turns carry `texts`, each line also carrying the cwd. */
    function searchSession(cwd: string, ...texts: string[]): string {
      return texts.map((text) => jl({ type: "user", message: { content: text }, cwd })).join("");
    }

    it("finds the match in a space the caller never guessed, without touching herdr", async () => {
      const noisy = "/tmp/proj-noisy";
      const quiet = "/tmp/proj-quiet";
      await writeSession(await makeSpace(noisy), U1, searchSession(noisy, "unrelated chatter"), new Date("2026-07-09T00:00:00Z"));
      await writeSession(await makeSpace(quiet), U2, searchSession(quiet, "fixed the flaky login test"), new Date("2026-07-01T00:00:00Z"));

      const { client, calls } = trackingClient();
      const result = await necromancy({ client }).searchAllSessions({ query: "FLAKY login" });

      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0]).toMatchObject({
        cwd: quiet, // recovered from the session's own cwd line, not the slug
        sessionId: U2,
        matchCount: 1,
        index: 0,
        role: "user",
        mtime: new Date("2026-07-01T00:00:00Z").getTime(),
        messageCount: 1,
      });
      expect(result.sessions[0]!.snippet).toContain("flaky login test");
      expect(result).toMatchObject({ total: 1, truncated: false, scanned: 2, scanTruncated: false });
      expect(calls).toEqual([]); // pure disk read: a herdr outage can't hide a hit
    });

    it("scans every space by default, newest-activity first, and only one space when given", async () => {
      const cwdA = "/tmp/proj-a";
      const cwdB = "/tmp/proj-b";
      await writeSession(await makeSpace(cwdA), U1, searchSession(cwdA, "the release blocker"), new Date("2026-07-02T00:00:00Z"));
      await writeSession(await makeSpace(cwdB), U2, searchSession(cwdB, "another release blocker"), new Date("2026-07-08T00:00:00Z"));

      const core = necromancy({ client: stubClient() });
      const all = await core.searchAllSessions({ query: "release blocker" });
      expect(all.sessions.map((s) => s.cwd)).toEqual([cwdB, cwdA]); // newest first
      expect(all.total).toBe(2);

      const scoped = await core.searchAllSessions({ query: "release blocker", space: cwdA });
      expect(scoped.sessions.map((s) => s.sessionId)).toEqual([U1]);
      expect(scoped.scanned).toBe(1); // the other space is never read at all
    });

    it("collapses every match inside one session into a single entry carrying matchCount", async () => {
      const cwd = "/tmp/proj-a";
      const dir = await makeSpace(cwd);
      await writeSession(dir, U1, searchSession(cwd, "deploy failed", "retrying the deploy", "deploy is green"));

      const { sessions, total } = await necromancy({ client: stubClient() }).searchAllSessions({ query: "deploy" });

      expect(total).toBe(1);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.matchCount).toBe(3);
      expect(sessions[0]!.index).toBe(0); // only the FIRST match is rendered
      expect(sessions[0]!.snippet).toContain("deploy failed");
      expect(sessions[0]!.messageCount).toBe(3);
    });

    it("caps the response with limit and reports total and truncated", async () => {
      const cwdOld = "/tmp/proj-old";
      const cwdMid = "/tmp/proj-mid";
      const cwdNew = "/tmp/proj-new";
      await writeSession(await makeSpace(cwdOld), U1, searchSession(cwdOld, "widget bug"), new Date("2026-07-01T00:00:00Z"));
      await writeSession(await makeSpace(cwdMid), U2, searchSession(cwdMid, "widget bug"), new Date("2026-07-05T00:00:00Z"));
      await writeSession(await makeSpace(cwdNew), U3, searchSession(cwdNew, "widget bug"), new Date("2026-07-09T00:00:00Z"));

      const result = await necromancy({ client: stubClient() }).searchAllSessions({ query: "widget", limit: 2 });

      expect(result.total).toBe(3);
      expect(result.truncated).toBe(true);
      expect(result.sessions.map((s) => s.cwd)).toEqual([cwdNew, cwdMid]);
      expect(result.scanTruncated).toBe(false); // every candidate was still scanned
    });

    it("stops at maxSessions and reports the partial scan instead of a silent miss", async () => {
      // The match lives in the OLDEST session, which a 2-file budget never
      // reaches: the caller must see scanTruncated, not an empty "not found".
      const cwdOld = "/tmp/proj-old";
      const cwdMid = "/tmp/proj-mid";
      const cwdNew = "/tmp/proj-new";
      await writeSession(await makeSpace(cwdOld), U1, searchSession(cwdOld, "the buried needle"), new Date("2026-07-01T00:00:00Z"));
      await writeSession(await makeSpace(cwdMid), U2, searchSession(cwdMid, "nothing here"), new Date("2026-07-05T00:00:00Z"));
      await writeSession(await makeSpace(cwdNew), U3, searchSession(cwdNew, "nothing here either"), new Date("2026-07-09T00:00:00Z"));

      const result = await necromancy({ client: stubClient() }).searchAllSessions({ query: "needle", maxSessions: 2 });

      expect(result.sessions).toEqual([]);
      expect(result.scanned).toBe(2);
      expect(result.scanTruncated).toBe(true);
      expect(result.total).toBe(0);
    });

    it("spends no scan budget on empty, oversized, or malformed session files", async () => {
      // The two skippable files are the NEWEST, so a budget of 2 would be gone
      // before the needle if the stat gate cost anything.
      const cwd = "/tmp/proj-a";
      const dir = await makeSpace(cwd);
      await writeSession(dir, U1, "", new Date("2026-07-09T00:00:00Z")); // empty: stat-gated, never read
      await writeSession(dir, U2, jl({ type: "user", message: { content: "x".repeat(500) }, cwd }), new Date("2026-07-08T00:00:00Z")); // oversized
      const malformed = join(dir, "44444444-4444-4444-4444-444444444444.jsonl");
      await writeFile(malformed, "not json\n{broken");
      await utimes(malformed, new Date("2026-07-07T00:00:00Z"), new Date("2026-07-07T00:00:00Z"));
      await writeSession(dir, U3, searchSession(cwd, "the needle"), new Date("2026-07-01T00:00:00Z"));

      const core = necromancy({ maxSessionBytes: 200, client: stubClient() });
      const result = await core.searchAllSessions({ query: "needle", maxSessions: 2 });

      // Budget spent only on the two files actually read (malformed + needle);
      // nothing was left unvisited, so the scan ran to completion.
      expect(result.sessions.map((s) => s.sessionId)).toEqual([U3]);
      expect(result.scanned).toBe(2);
      expect(result.scanTruncated).toBe(false);
    });

    it("matches a regex pattern when regex is true", async () => {
      const cwd = "/tmp/proj-a";
      const dir = await makeSpace(cwd);
      await writeSession(dir, U1, searchSession(cwd, "cut the release at v1.12.3 today"), new Date("2026-07-08T00:00:00Z"));
      await writeSession(dir, U2, searchSession(cwd, "no version here"), new Date("2026-07-01T00:00:00Z"));

      const result = await necromancy({ client: stubClient() }).searchAllSessions({
        query: "v\\d+\\.\\d+\\.\\d+",
        regex: true,
      });

      expect(result.sessions.map((s) => s.sessionId)).toEqual([U1]);
      expect(result.sessions[0]!.snippet).toContain("v1.12.3");
    });

    it("rejects an invalid regex with a typed error instead of silently searching for it literally", async () => {
      const cwd = "/tmp/proj-a";
      await writeSession(await makeSpace(cwd), U1, searchSession(cwd, "a [unclosed bracket"));

      const core = necromancy({ client: stubClient() });
      const error = await core.searchAllSessions({ query: "[unclosed", regex: true }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(NecromancyError);
      expect((error as NecromancyError).code).toBe("invalid_regex");

      // The same query without regex:true is a plain substring, not an error.
      const literal = await core.searchAllSessions({ query: "[unclosed" });
      expect(literal.sessions.map((s) => s.sessionId)).toEqual([U1]);
    });

    it("returns empty without crashing when there is no graveyard at all", async () => {
      const core = createNecromancy({ projectsRoot: join(root, "does-not-exist"), client: stubClient() });

      expect(await core.searchAllSessions({ query: "anything" })).toEqual({
        sessions: [],
        total: 0,
        truncated: false,
        scanned: 0,
        scanTruncated: false,
      });
    });
  });

  describe("resolveHandle - herdr agent address -> session", () => {
    const WS = stubWorkspace("wC", "/repos/upublish", "upublish");
    const TABS: Tab[] = [
      { id: "wC:t7", workspaceId: "wC", label: "1", number: 7, focused: false },
      { id: "wC:t8", workspaceId: "wC", label: "2", number: 8, focused: false },
    ];
    const PANES: Pane[] = [
      { id: "wC:p8", workspaceId: "wC", tabId: "wC:t7", agent: "claude", sessionId: U1, cwd: "/repos/upublish", status: "idle" },
      { id: "wC:p9", workspaceId: "wC", tabId: "wC:t8", agent: "claude", sessionId: U2, cwd: "/repos/upublish", status: "idle" },
    ];
    const clientFor = (workspaces: Workspace[], tabs: Tab[], panes: Pane[]) =>
      stubClient({ workspaceList: async () => workspaces, tabList: async () => tabs, paneList: async () => panes });
    const core = (workspaces: Workspace[], tabs: Tab[], panes: Pane[]) =>
      necromancy({ client: clientFor(workspaces, tabs, panes) });

    it("resolves `upublish:1` to the tab-1 pane's session in one shot", async () => {
      const r = await core([WS], TABS, PANES).resolveHandle({ handle: "upublish:1" });
      expect(r).toEqual({
        status: "resolved",
        sessionId: U1,
        cwd: "/repos/upublish",
        workspaceLabel: "upublish",
        matchedTabLabel: "1",
        handle: "upublish:1",
        live: true,
        isCurrent: false,
      });
    });

    it("flags isCurrent when the resolved session equals currentSessionId", async () => {
      const r = await core([WS], TABS, PANES).resolveHandle({ handle: "upublish:1", currentSessionId: U1 });
      expect((r as { isCurrent?: boolean }).isCurrent).toBe(true);
    });

    it("falls back to positional index when the part after ':' is not a tab label, echoing the real matched label", async () => {
      const tabs: Tab[] = [
        { id: "wC:t7", workspaceId: "wC", label: "build", number: 7, focused: false },
        { id: "wC:t8", workspaceId: "wC", label: "ship", number: 8, focused: false },
      ];
      const r = await core([WS], tabs, PANES).resolveHandle({ handle: "upublish:1" });
      expect(r).toMatchObject({ status: "resolved", sessionId: U1, matchedTabLabel: "build", handle: "upublish:build" });
    });

    it("returns not_found:tab when neither a label nor a positional index matches", async () => {
      const r = await core([WS], TABS, PANES).resolveHandle({ handle: "upublish:9" });
      expect(r).toMatchObject({ status: "not_found", reason: "tab" });
    });

    it("returns not_found:no_claude_agent when the tab holds only a shell pane", async () => {
      const panes: Pane[] = [{ ...PANES[0]!, agent: "", sessionId: "" }, PANES[1]!];
      const r = await core([WS], TABS, panes).resolveHandle({ handle: "upublish:1" });
      expect(r).toMatchObject({ status: "not_found", reason: "no_claude_agent" });
    });

    it("excludes a non-claude agent (e.g. codex) from resolution", async () => {
      const panes: Pane[] = [{ ...PANES[0]!, agent: "codex", sessionId: U3 }, PANES[1]!];
      const r = await core([WS], TABS, panes).resolveHandle({ handle: "upublish:1" });
      expect(r).toMatchObject({ status: "not_found", reason: "no_claude_agent" });
    });

    it("returns ambiguous_workspace with candidates when a label matches two workspaces", async () => {
      const workspaces = [stubWorkspace("wC", "/a", "scratch"), stubWorkspace("wD", "/b", "scratch")];
      const r = await core(workspaces, TABS, PANES).resolveHandle({ handle: "scratch:1" });
      expect(r).toMatchObject({ status: "ambiguous_workspace", query: "scratch" });
      expect((r as { candidates: unknown[] }).candidates).toHaveLength(2);
    });

    it("widens to a substring workspace match when no label matches exactly", async () => {
      const workspaces = [stubWorkspace("wC", "/repos/upublish", "grug-brain.mcp")];
      const r = await core(workspaces, TABS, PANES).resolveHandle({ handle: "grug:1" });
      expect(r).toMatchObject({ status: "resolved", sessionId: U1, handle: "grug-brain.mcp:1" });
    });

    it("returns not_found:workspace when nothing matches", async () => {
      const r = await core([WS], TABS, PANES).resolveHandle({ handle: "nope:1" });
      expect(r).toMatchObject({ status: "not_found", reason: "workspace" });
    });

    it("resolves a bare label to the workspace's sole claude pane (handle without a tab)", async () => {
      const r = await core([WS], [TABS[0]!], [PANES[0]!]).resolveHandle({ handle: "upublish" });
      expect(r).toMatchObject({ status: "resolved", sessionId: U1, matchedTabLabel: null, handle: "upublish" });
    });

    it("returns ambiguous_pane when a bare label has multiple claude panes", async () => {
      const r = await core([WS], TABS, PANES).resolveHandle({ handle: "upublish" });
      expect(r).toMatchObject({ status: "ambiguous_pane", workspaceLabel: "upublish" });
      expect((r as { candidates: unknown[] }).candidates).toHaveLength(2);
    });

    it("resolves label-less `:1` against the provided current workspaceId", async () => {
      const r = await core([WS], TABS, PANES).resolveHandle({ handle: ":1", workspaceId: "wC" });
      expect(r).toMatchObject({ status: "resolved", sessionId: U1, handle: "upublish:1" });
    });

    it("returns not_found:no_current_workspace for a label-less handle with no workspaceId", async () => {
      const r = await core([WS], TABS, PANES).resolveHandle({ handle: ":1" });
      expect(r).toMatchObject({ status: "not_found", reason: "no_current_workspace" });
    });

    it("returns not_found:invalid_handle for an empty handle", async () => {
      const r = await core([WS], TABS, PANES).resolveHandle({ handle: "  " });
      expect(r).toMatchObject({ status: "not_found", reason: "invalid_handle" });
    });

    it("resolves a duplicate tab label to the lowest-numbered tab", async () => {
      const tabs: Tab[] = [
        { id: "wC:t8", workspaceId: "wC", label: "1", number: 8, focused: false },
        { id: "wC:t7", workspaceId: "wC", label: "1", number: 7, focused: false },
      ];
      const r = await core([WS], tabs, PANES).resolveHandle({ handle: "upublish:1" });
      expect(r).toMatchObject({ status: "resolved", sessionId: U1 }); // tab t7 (number 7) -> pane p8 -> U1
    });

    it("propagates a herdr outage as a thrown HerdrError (herdr required for resolution)", async () => {
      const client = stubClient({
        workspaceList: async () => {
          throw new HerdrError("spawn_failed", "herdr is down");
        },
      });
      const err = await necromancy({ client }).resolveHandle({ handle: "upublish:1" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HerdrError);
    });
  });
});
