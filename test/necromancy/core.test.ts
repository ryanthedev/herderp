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
  type NecromancyOptions,
} from "../../src/necromancy/core.js";
import { createHerdrClient, type HerdrClient, type HerdrRunner } from "../../src/herdr/client.js";
import { HerdrError, type Agent, type Workspace } from "../../src/herdr/types.js";

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
    ...overrides,
  } as HerdrClient;
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

      const core = necromancy({ client: stubClient({ agentList: async () => [stubAgent(U3)] }) });
      const sessions = await core.listSessions(cwd);

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
        client: stubClient({ agentList: async () => [] }),
      });
      const sessions = await core.listSessions(cwd);

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

      const core = necromancy({ client: stubClient({ agentList: async () => [] }) });
      const sessions = await core.listSessions(cwd);

      expect(sessions.map((s) => s.id)).toEqual([U1]);
    });

    it("DW_3_5_live_id_without_file_does_not_break_listSessions", async () => {
      const cwd = "/tmp/proj-a";
      const dir = await makeSpace(cwd);
      await writeSession(dir, U1, sessionContent("on disk", cwd));

      const core = necromancy({
        client: stubClient({ agentList: async () => [stubAgent(U2)] }), // U2 live in herdr, no file
      });
      const sessions = await core.listSessions(cwd);

      expect(sessions.map((s) => s.id)).toEqual([U1]); // disk is authoritative
      expect(sessions[0]!.live).toBe(false);
    });

    it("DW_3_3_unknown_space_returns_empty_without_touching_herdr", async () => {
      const { client, calls } = trackingClient();
      const core = necromancy({ client });

      expect(await core.listSessions("/no/such/space")).toEqual([]);
      expect(calls).toEqual([]);
    });

    it("DW_3_3_a_herdr_failure_surfaces_as_a_typed_HerdrError_not_all_dead", async () => {
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
      const err = await core.listSessions(cwd).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(HerdrError);
      expect((err as HerdrError).code).toBe("spawn_failed");
    });
  });
});
