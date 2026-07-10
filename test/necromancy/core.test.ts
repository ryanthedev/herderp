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
import type { HerdrClient } from "../../src/herdr/client.js";
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
      const spaces = await core.findSpaces();

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

    it("DW_3_2_findSpaces_space_with_no_sessions_degrades_to_the_raw_slug", async () => {
      await mkdir(join(root, "-tmp-empty-space"), { recursive: true });

      const core = necromancy({ client: stubClient({ workspaceList: async () => [] }) });
      const spaces = await core.findSpaces();

      expect(spaces).toEqual([
        { cwd: "-tmp-empty-space", label: null, workspaceId: null, sessionCount: 0, lastActivity: null },
      ]);
    });

    it("DW_3_2_missing_projects_root_returns_empty_no_crash", async () => {
      const core = createNecromancy({
        projectsRoot: join(root, "does-not-exist"),
        client: stubClient(), // any herdr call would throw "unexpected"
      });

      expect(await core.findSpaces()).toEqual([]);
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
      const spaces = await core.findSpaces();

      expect(spaces).toHaveLength(1);
      expect(spaces[0]!.workspaceId).toBe("w1");
      expect(spaces[0]!.label).toBe("first");
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

  describe("revive - DW-3.4 / DW-3.5", () => {
    const cwd = "/tmp/proj-a";
    const created = { ...stubWorkspace("w9", cwd), rootPaneId: "w9:p1" };

    async function seedSession(id: string): Promise<void> {
      const dir = await makeSpace(cwd);
      await writeSession(dir, id, sessionContent("dead session", cwd));
    }

    it("DW_3_4_revive_creates_workspace_runs_claude_resume_and_returns_the_detected_agent", async () => {
      await seedSession(U1);
      const paneRuns: Array<[string, string]> = [];
      const sleeps: number[] = [];
      let polls = 0;

      const core = necromancy({
        pollIntervalMs: 100,
        detectTimeoutMs: 1_000,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        client: stubClient({
          workspaceCreate: async (opts) => {
            expect(opts).toEqual({ cwd });
            return created;
          },
          paneRun: async (paneId, command) => {
            paneRuns.push([paneId, command]);
          },
          // Detection lags one poll: first agentList misses, second finds it
          // in a DIFFERENT pane - the detected placement must win.
          agentList: async () => (++polls < 2 ? [] : [stubAgent(U1, "w9", "w9:p2")]),
        }),
      });
      const result = await core.revive({ sessionId: U1, cwd });

      expect(paneRuns).toEqual([["w9:p1", `claude --resume ${U1}`]]);
      expect(result).toEqual({ workspaceId: "w9", paneId: "w9:p2", sessionId: U1, detected: true });
      expect(sleeps).toEqual([100]);
    });

    it("DW_3_4_detection_never_arrives_bounded_wait_returns_detected_false", async () => {
      await seedSession(U1);
      let polls = 0;
      let sleepCount = 0;

      const core = necromancy({
        pollIntervalMs: 100,
        detectTimeoutMs: 300,
        sleep: async () => {
          sleepCount += 1;
        },
        client: stubClient({
          workspaceCreate: async () => created,
          paneRun: async () => undefined,
          agentList: async () => {
            polls += 1;
            return [];
          },
        }),
      });
      const result = await core.revive({ sessionId: U1, cwd });

      expect(result).toEqual({ workspaceId: "w9", paneId: "w9:p1", sessionId: U1, detected: false });
      expect(polls).toBe(4); // elapsed 0/100/200/300 - deterministic bound
      expect(sleepCount).toBe(3);
    });

    it("DW_3_4_default_sleep_is_a_real_timer_between_polls", async () => {
      // No injected sleep: the default setTimeout-backed sleep runs for real
      // (1ms cadence keeps the test instant).
      await seedSession(U1);
      let polls = 0;

      const core = necromancy({
        pollIntervalMs: 1,
        detectTimeoutMs: 50,
        client: stubClient({
          workspaceCreate: async () => created,
          paneRun: async () => undefined,
          agentList: async () => (++polls < 2 ? [] : [stubAgent(U1, "w9", "w9:p1")]),
        }),
      });
      const result = await core.revive({ sessionId: U1, cwd });

      expect(result.detected).toBe(true);
      expect(polls).toBe(2);
    });

    it("DW_3_4_workspaceCreate_failure_surfaces_typed_and_paneRun_is_never_reached", async () => {
      await seedSession(U1);
      const paneRuns: string[] = [];

      const core = necromancy({
        client: stubClient({
          workspaceCreate: async () => {
            throw new HerdrError("command_failed", "workspace limit reached");
          },
          paneRun: async (paneId) => {
            paneRuns.push(paneId);
          },
        }),
      });
      const err = await core.revive({ sessionId: U1, cwd }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(HerdrError);
      expect((err as HerdrError).code).toBe("command_failed");
      expect(paneRuns).toEqual([]);
    });

    it("DW_3_4_paneRun_failure_surfaces_typed_without_a_partial_state_crash", async () => {
      await seedSession(U1);

      const core = necromancy({
        client: stubClient({
          workspaceCreate: async () => created,
          paneRun: async () => {
            throw new HerdrError("command_failed", "pane w9:p1 not found");
          },
        }),
      });
      const err = await core.revive({ sessionId: U1, cwd }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(HerdrError);
      expect((err as HerdrError).code).toBe("command_failed");
    });

    it("DW_3_5_non_uuid_id_rejected_before_any_command_is_constructed", async () => {
      await seedSession(U1);
      const maliciousIds = [
        "x; rm -rf ~",
        "$(whoami)",
        "`touch /tmp/pwned`",
        `${U1}; echo pwned`,
        `${U1}\n`,
        "11111111-1111-1111-1111-11111111111Z",
        "--help",
        "",
      ];

      for (const sessionId of maliciousIds) {
        const { client, calls } = trackingClient();
        const core = necromancy({ client });

        const err = await core.revive({ sessionId, cwd }).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(NecromancyError);
        expect((err as NecromancyError).code).toBe("invalid_session_id");
        expect(calls).toEqual([]); // zero herdr calls: nothing was constructed or run
      }
    });

    it("DW_3_5_uuid_with_no_ondisk_file_rejected_typed_before_any_herdr_call", async () => {
      await makeSpace(cwd); // space exists, session file does not
      const { client, calls } = trackingClient();
      const core = necromancy({ client });

      const err = await core.revive({ sessionId: U2, cwd }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(NecromancyError);
      expect((err as NecromancyError).code).toBe("session_not_found");
      expect(calls).toEqual([]);
    });
  });
});
