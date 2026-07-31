// Unit tests for HerdrClient (src/herdr/client.ts) against a stubbed
// HerdrRunner - no real `herdr` process is ever spawned. Each test injects
// canned {stdout,stderr,exitCode} responses and asserts both the exact argv
// HerdrClient sent and the typed value/error it produced.

import { describe, expect, it } from "bun:test";
import { createHerdrClient, type HerdrRunResult, type HerdrRunner } from "../../src/herdr/client.js";
import { HerdrError, type Agent, type Pane, type Tab } from "../../src/herdr/types.js";

/** A stubbed runner that returns canned results in call order and records
 * every argv it was invoked with. */
function stubRunner(results: HerdrRunResult[]): { runner: HerdrRunner; calls: string[][] } {
  const calls: string[][] = [];
  let index = 0;
  const runner: HerdrRunner = async (argv) => {
    calls.push(argv);
    const result = results[index++];
    if (!result) throw new Error(`stubRunner: no canned result for call #${index} (argv=${argv.join(" ")})`);
    return result;
  };
  return { runner, calls };
}

function ok(stdout: string): HerdrRunResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function fail(exitCode: number, opts: { stdout?: string; stderr?: string }): HerdrRunResult {
  return { stdout: opts.stdout ?? "", stderr: opts.stderr ?? "", exitCode };
}

const RAW_AGENT = {
  agent: "claude",
  agent_session: { agent: "claude", kind: "id", source: "herdr:claude", value: "7871b8f6-0ebc-4279-9a76-66f35896fee0" },
  agent_status: "idle",
  cwd: "/Users/r/.config",
  focused: false,
  foreground_cwd: "/Users/r/.config",
  pane_id: "w3:p1",
  revision: 0,
  tab_id: "w3:t1",
  terminal_id: "term_1",
  workspace_id: "w3",
};

const MAPPED_AGENT: Agent = {
  agent: "claude",
  sessionId: "7871b8f6-0ebc-4279-9a76-66f35896fee0",
  status: "idle",
  cwd: "/Users/r/.config",
  workspaceId: "w3",
  tabId: "w3:t1",
  paneId: "w3:p1",
};

describe("HerdrClient - DW-2.1 parse-success per method", () => {
  it("DW_2_1_agentList_spawns_agent_list_and_maps_the_seam_type", async () => {
    const { runner, calls } = stubRunner([
      ok(JSON.stringify({ id: "cli:agent:list", result: { agents: [RAW_AGENT], type: "agent_list" } })),
    ]);
    const client = createHerdrClient(runner);

    const agents = await client.agentList();

    expect(calls).toEqual([["agent", "list"]]);
    expect(agents).toEqual([MAPPED_AGENT]);
  });

  it("DW_2_1_agentGet_spawns_agent_get_target_and_maps_the_seam_type", async () => {
    const { runner, calls } = stubRunner([
      ok(JSON.stringify({ id: "cli:agent:get", result: { agent: RAW_AGENT, type: "agent_info" } })),
    ]);
    const client = createHerdrClient(runner);

    const agent = await client.agentGet("w3:p1");

    expect(calls).toEqual([["agent", "get", "w3:p1"]]);
    expect(agent).toEqual(MAPPED_AGENT);
  });

  // `agent read` is the one subcommand with no JSON envelope: stdout IS the
  // terminal snapshot. The stub below is a verbatim capture of
  // `herdr agent read <target> --lines 5` against herdr 0.7.5 (box-drawing
  // rule, prompt line, status line, trailing newline), not a JSON body.
  const RAW_SNAPSHOT =
    "────────────────────────────\n" +
    "❯ ok, we need to add a headless claude adapter.\n" +
    "────────────────────────────\n" +
    "   18:34 ·  Opus ·  5 ·  (1M context)       high%\n" +
    "  -- INSERT -- ⏸ manual mode on\n";

  it("DW_2_1_agentRead_spawns_agent_read_with_flags_and_returns_raw_stdout", async () => {
    const { runner, calls } = stubRunner([ok(RAW_SNAPSHOT)]);
    const client = createHerdrClient(runner);

    const text = await client.agentRead("w3:p1", { lines: 3, source: "recent" });

    expect(calls).toEqual([["agent", "read", "w3:p1", "--source", "recent", "--lines", "3"]]);
    expect(text).toBe(RAW_SNAPSHOT);
  });

  it("DW_2_1_agentRead_returns_the_snapshot_verbatim_without_trimming", async () => {
    const { runner } = stubRunner([ok("  indented\n\n")]);
    const client = createHerdrClient(runner);

    // Leading indentation and trailing blank lines are pane content, not
    // formatting noise - the raw path must not trim them away.
    expect(await client.agentRead("w3:p1")).toBe("  indented\n\n");
  });

  // The flag is `--until`, not `--status`. Verified against herdr 0.7.5:
  // `herdr agent wait <t> --status idle` exits 2 with `unknown option:
  // --status`, so the argv this client sent could never reach a real wait.
  it("DW_2_1_agentWait_spawns_agent_wait_with_until_and_timeout_and_maps_result", async () => {
    const { runner, calls } = stubRunner([
      ok(JSON.stringify({ id: "cli:agent:wait:resolve", result: { agent: RAW_AGENT, type: "agent_info" } })),
    ]);
    const client = createHerdrClient(runner);

    const agent = await client.agentWait("w3:p1", { status: "idle", timeoutMs: 500 });

    expect(calls).toEqual([["agent", "wait", "w3:p1", "--until", "idle", "--timeout", "500"]]);
    expect(agent).toEqual(MAPPED_AGENT);
  });

  it("DW_2_1_agentWait_repeats_until_once_per_state", async () => {
    // herdr: "--until <STATUS>  State to match; repeat for more than one".
    const { runner, calls } = stubRunner([
      ok(JSON.stringify({ id: "cli:agent:wait:resolve", result: { agent: RAW_AGENT } })),
    ]);
    const client = createHerdrClient(runner);

    await client.agentWait("w3:p1", { status: ["idle", "done"] });

    expect(calls).toEqual([["agent", "wait", "w3:p1", "--until", "idle", "--until", "done"]]);
  });

  it("DW_2_1_agentWait_emits_no_until_flag_when_no_state_is_requested", async () => {
    // Omitting --until is meaningful, not a mistake: herdr then matches
    // "idle, done, or blocked". A bare `--until` would be a usage error.
    const { runner, calls } = stubRunner([
      ok(JSON.stringify({ id: "cli:agent:wait:resolve", result: { agent: RAW_AGENT } })),
    ]);
    const client = createHerdrClient(runner);

    await client.agentWait("w3:p1", {});

    expect(calls).toEqual([["agent", "wait", "w3:p1"]]);
  });

  it("DW_2_1_agentWait_accepts_done_which_the_CLI_allows", async () => {
    // `agent wait --help` lists done among the possible values. The client
    // used to exclude it in its own type, removing the state an agent
    // actually rests in after finishing.
    const { runner, calls } = stubRunner([
      ok(JSON.stringify({ id: "cli:agent:wait:resolve", result: { agent: RAW_AGENT } })),
    ]);
    const client = createHerdrClient(runner);

    await client.agentWait("w3:p1", { status: "done" });

    expect(calls).toEqual([["agent", "wait", "w3:p1", "--until", "done"]]);
  });

  it("DW_2_1_agentPrompt_spawns_agent_prompt_with_the_text_as_a_positional", async () => {
    // `herdr agent prompt <TARGET> <TEXT>` - the replacement for the
    // `agent send` subcommand this client used to shell, which herdr 0.7.5
    // does not have at all.
    const { runner, calls } = stubRunner([ok("")]);
    const client = createHerdrClient(runner);

    await client.agentPrompt("w3:p1", "run the tests");

    expect(calls).toEqual([["agent", "prompt", "w3:p1", "run the tests"]]);
  });

  it("DW_2_1_agentPrompt_passes_wait_until_and_timeout_flags", async () => {
    const { runner, calls } = stubRunner([ok("")]);
    const client = createHerdrClient(runner);

    await client.agentPrompt("w3:p1", "go", { wait: true, until: ["done", "blocked"], timeoutMs: 60000 });

    expect(calls).toEqual([
      ["agent", "prompt", "w3:p1", "go", "--wait", "--until", "done", "--until", "blocked", "--timeout", "60000"],
    ]);
  });

  it("DW_2_1_agentSendKeys_spawns_send_keys_with_one_positional_per_key", async () => {
    const { runner, calls } = stubRunner([ok("")]);
    const client = createHerdrClient(runner);

    await client.agentSendKeys("w3:p1", ["esc", "esc"]);

    expect(calls).toEqual([["agent", "send-keys", "w3:p1", "esc", "esc"]]);
  });

  it("DW_2_1_agentSendKeys_rejects_an_empty_key_list_before_spawning", async () => {
    const { runner, calls } = stubRunner([]);
    const client = createHerdrClient(runner);

    const err = await client.agentSendKeys("w3:p1", []).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HerdrError);
    expect((err as HerdrError).code).toBe("invalid_request");
    expect(calls).toEqual([]);
  });

  it("DW_2_1_agentStart_spawns_the_real_kind_and_pane_grammar", async () => {
    // `agent start <NAME> --kind <KIND> --pane <ID> [--timeout MS] [-- args]`.
    // The old argv sent --cwd/--workspace/--tab/--split/--env/--focus, every
    // one of which herdr rejects with `unknown option`, and sent neither of
    // the two flags that are actually required.
    const { runner, calls } = stubRunner([ok("")]);
    const client = createHerdrClient(runner);

    await client.agentStart({ name: "worker", kind: "claude", paneId: "w3:p1", timeoutMs: 45000 });

    expect(calls).toEqual([["agent", "start", "worker", "--kind", "claude", "--pane", "w3:p1", "--timeout", "45000"]]);
  });

  it("DW_2_1_agentStart_appends_agent_argv_after_the_separator_and_omits_a_bare_one", async () => {
    const { runner, calls } = stubRunner([ok(""), ok("")]);
    const client = createHerdrClient(runner);

    await client.agentStart({ name: "w", kind: "codex", paneId: "w3:p1", argv: ["--model", "o3"] });
    await client.agentStart({ name: "w", kind: "codex", paneId: "w3:p1", argv: [] });

    expect(calls).toEqual([
      ["agent", "start", "w", "--kind", "codex", "--pane", "w3:p1", "--", "--model", "o3"],
      ["agent", "start", "w", "--kind", "codex", "--pane", "w3:p1"],
    ]);
  });

  it("DW_2_1_workspaceList_spawns_workspace_list_then_joins_cwd_via_pane_list_per_workspace", async () => {
    const { runner, calls } = stubRunner([
      ok(
        JSON.stringify({
          id: "cli:workspace:list",
          result: { workspaces: [{ workspace_id: "w3", label: ".config", tab_count: 1, pane_count: 1, agent_status: "idle", focused: false, active_tab_id: "w3:t1", number: 1 }] },
        }),
      ),
      ok(
        JSON.stringify({
          id: "cli:pane:list",
          result: { panes: [{ ...RAW_AGENT }], type: "pane_list" },
        }),
      ),
    ]);
    const client = createHerdrClient(runner);

    const workspaces = await client.workspaceList();

    expect(calls).toEqual([
      ["workspace", "list"],
      ["pane", "list", "--workspace", "w3"],
    ]);
    expect(workspaces).toEqual([{ id: "w3", label: ".config", cwd: "/Users/r/.config", tabCount: 1, paneCount: 1 }]);
  });

  it("DW_2_1_workspaceCreate_spawns_workspace_create_with_flags_and_echoes_the_requested_cwd", async () => {
    // Envelope shape matches the live-captured `workspace create` response
    // (phase-3 discovery): result carries both `workspace` and `root_pane`.
    const { runner, calls } = stubRunner([
      ok(
        JSON.stringify({
          id: "cli:workspace:create",
          result: {
            root_pane: { pane_id: "w9:p1", tab_id: "w9:t1", workspace_id: "w9", cwd: "/tmp/x" },
            workspace: { workspace_id: "w9", label: "foo", tab_count: 1, pane_count: 1 },
            type: "workspace_created",
          },
        }),
      ),
    ]);
    const client = createHerdrClient(runner);

    const workspace = await client.workspaceCreate({ cwd: "/tmp/x", label: "foo", focus: true });

    expect(calls).toEqual([["workspace", "create", "--cwd", "/tmp/x", "--label", "foo", "--focus"]]);
    expect(workspace).toEqual({ id: "w9", label: "foo", cwd: "/tmp/x", tabCount: 1, paneCount: 1, rootPaneId: "w9:p1" });
  });

  it("DW_3_4_workspaceCreate_surfaces_rootPaneId_from_the_create_envelopes_root_pane", async () => {
    const { runner } = stubRunner([
      ok(
        JSON.stringify({
          id: "cli:workspace:create",
          result: {
            root_pane: { pane_id: "wK:p1", tab_id: "wK:t1", workspace_id: "wK", cwd: "/tmp/y" },
            workspace: { workspace_id: "wK", tab_count: 1, pane_count: 1 },
            type: "workspace_created",
          },
        }),
      ),
    ]);
    const client = createHerdrClient(runner);

    const workspace = await client.workspaceCreate({ cwd: "/tmp/y" });

    expect(workspace.rootPaneId).toBe("wK:p1");
  });

  it("DW_3_4_workspaceCreate_throws_invalid_response_when_root_pane_pane_id_is_missing", async () => {
    const { runner } = stubRunner([
      ok(
        JSON.stringify({
          id: "cli:workspace:create",
          result: { workspace: { workspace_id: "w9", tab_count: 1, pane_count: 1 } },
        }),
      ),
    ]);
    const client = createHerdrClient(runner);

    const err = await client.workspaceCreate({ cwd: "/tmp/x" }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HerdrError);
    expect((err as HerdrError).code).toBe("invalid_response");
    expect((err as HerdrError).message).toContain("root_pane");
  });

  it("DW_3_4_workspaceCreate_throws_invalid_response_when_root_pane_pane_id_is_not_a_string", async () => {
    const { runner } = stubRunner([
      ok(
        JSON.stringify({
          id: "cli:workspace:create",
          result: {
            root_pane: { pane_id: 123, tab_id: "w9:t1", workspace_id: "w9", cwd: "/tmp/x" },
            workspace: { workspace_id: "w9", tab_count: 1, pane_count: 1 },
          },
        }),
      ),
    ]);
    const client = createHerdrClient(runner);

    const err = await client.workspaceCreate({ cwd: "/tmp/x" }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HerdrError);
    expect((err as HerdrError).code).toBe("invalid_response");
    expect((err as HerdrError).message).toContain("result.root_pane.pane_id to be a string");
  });

  it("DW_2_1_workspaceFocus_spawns_workspace_focus_and_resolves_void", async () => {
    const { runner, calls } = stubRunner([ok(JSON.stringify({ id: "cli:workspace:focus", result: {} }))]);
    const client = createHerdrClient(runner);

    await expect(client.workspaceFocus("w9")).resolves.toBeUndefined();
    expect(calls).toEqual([["workspace", "focus", "w9"]]);
  });

  it("DW_2_1_paneRun_spawns_pane_run_with_paneId_and_command", async () => {
    const { runner, calls } = stubRunner([ok(JSON.stringify({ id: "cli:pane:run", result: {} }))]);
    const client = createHerdrClient(runner);

    await expect(client.paneRun("w3:p1", "echo hi")).resolves.toBeUndefined();
    expect(calls).toEqual([["pane", "run", "w3:p1", "echo hi"]]);
  });

  // Regression test for a bug live e2e verification found in Phase 4: real
  // herdr 0.7.1 prints nothing to stdout on a successful `pane run` (unlike
  // every other subcommand, which always echoes a JSON envelope) - the
  // original implementation ran this through the JSON-requiring `runHerdr`
  // and threw `invalid_response` on every real pane run, even though the stub
  // above (a fabricated JSON success body) made the unit suite pass.
  it("DW_2_1_paneRun_tolerates_empty_stdout_on_success_live_herdr_behavior", async () => {
    const { runner, calls } = stubRunner([ok("")]);
    const client = createHerdrClient(runner);

    await expect(client.paneRun("w3:p1", "claude --resume 11111111-1111-1111-1111-111111111111")).resolves.toBeUndefined();
    expect(calls).toEqual([["pane", "run", "w3:p1", "claude --resume 11111111-1111-1111-1111-111111111111"]]);
  });

  it("DW_2_2_paneRun_nonzero_exit_surfaces_herdrs_pane_not_found_from_the_stderr_envelope", async () => {
    // Verified live: `herdr pane run wZZ:pZZ true` -> exit 1, stdout EMPTY,
    // `{"error":{"code":"pane_not_found",...},"id":"cli:request"}` on stderr.
    // The void runner shares throwOnNonZeroExit, so it gets the typed code
    // too - it is not a JSON-parsing method, but it is an erroring one.
    const envelope = JSON.stringify({ error: { code: "pane_not_found", message: "pane wZZ:pZZ not found" }, id: "cli:request" });
    const { runner } = stubRunner([fail(1, { stderr: `${envelope}\n` })]);
    const client = createHerdrClient(runner);

    const err = await client.paneRun("wZZ:pZZ", "echo hi").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HerdrError);
    expect((err as HerdrError).code).toBe("pane_not_found");
    expect((err as HerdrError).message).toBe("pane wZZ:pZZ not found");
  });

  it("DW_2_2_paneRun_nonzero_exit_with_no_envelope_still_raises_a_typed_command_failed_error", async () => {
    const { runner } = stubRunner([fail(1, { stderr: "something went wrong" })]);
    const client = createHerdrClient(runner);

    const err = await client.paneRun("w9:p1", "echo hi").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HerdrError);
    expect((err as HerdrError).code).toBe("command_failed");
    expect((err as HerdrError).message).toContain("something went wrong");
  });

  it("DW_2_1_paneClose_spawns_pane_close_with_paneId", async () => {
    const { runner, calls } = stubRunner([ok(JSON.stringify({ id: "cli:pane:close", result: {} }))]);
    const client = createHerdrClient(runner);

    await expect(client.paneClose("w3:p1")).resolves.toBeUndefined();
    expect(calls).toEqual([["pane", "close", "w3:p1"]]);
  });

  it("DW_2_1_sessionList_spawns_session_list_json_and_parses_the_bare_envelope", async () => {
    const { runner, calls } = stubRunner([
      ok(JSON.stringify({ sessions: [{ default: true, name: "default", running: true, session_dir: "/x", socket_path: "/x.sock" }] })),
    ]);
    const client = createHerdrClient(runner);

    const sessions = await client.sessionList();

    expect(calls).toEqual([["session", "list", "--json"]]);
    expect(sessions).toEqual([{ name: "default", default: true, running: true }]);
  });
});

describe("HerdrClient - tabList/paneList (session-resolution seam)", () => {
  const RAW_TAB = { agent_status: "idle", focused: false, label: "1", number: 7, pane_count: 1, tab_id: "wC:t7", workspace_id: "wC" };
  const MAPPED_TAB: Tab = { id: "wC:t7", workspaceId: "wC", label: "1", number: 7, focused: false };
  const RAW_PANE = {
    agent: "claude",
    agent_session: { agent: "claude", kind: "id", source: "herdr:claude", value: "a5e24ccb-82d0-442d-b60a-502a2c9367dd" },
    agent_status: "idle",
    cwd: "/Users/r/repos/upublish",
    focused: false,
    foreground_cwd: "/Users/r/repos/upublish",
    pane_id: "wC:p8",
    revision: 0,
    tab_id: "wC:t7",
    terminal_id: "term_x",
    workspace_id: "wC",
  };
  const MAPPED_PANE: Pane = {
    id: "wC:p8",
    workspaceId: "wC",
    tabId: "wC:t7",
    agent: "claude",
    sessionId: "a5e24ccb-82d0-442d-b60a-502a2c9367dd",
    cwd: "/Users/r/repos/upublish",
    status: "idle",
  };

  it("tabList bare spawns `tab list` and maps tab_id/label/number", async () => {
    const { runner, calls } = stubRunner([ok(JSON.stringify({ id: "cli:tab:list", result: { tabs: [RAW_TAB], type: "tab_list" } }))]);
    const tabs = await createHerdrClient(runner).tabList();
    expect(calls).toEqual([["tab", "list"]]);
    expect(tabs).toEqual([MAPPED_TAB]);
  });

  it("tabList scoped passes --workspace", async () => {
    const { runner, calls } = stubRunner([ok(JSON.stringify({ id: "cli:tab:list", result: { tabs: [] } }))]);
    await createHerdrClient(runner).tabList("wC");
    expect(calls).toEqual([["tab", "list", "--workspace", "wC"]]);
  });

  it("tabList tolerates a missing label/number (null label, number 0) rather than crashing", async () => {
    const raw = { tab_id: "wC:t7", workspace_id: "wC" }; // no label, no number
    const { runner } = stubRunner([ok(JSON.stringify({ id: "cli:tab:list", result: { tabs: [raw] } }))]);
    const tabs = await createHerdrClient(runner).tabList();
    expect(tabs[0]).toEqual({ id: "wC:t7", workspaceId: "wC", label: null, number: 0, focused: false });
  });

  it("tabList throws invalid_response when result.tabs is not an array", async () => {
    const { runner } = stubRunner([ok(JSON.stringify({ id: "cli:tab:list", result: { tabs: "nope" } }))]);
    const err = await createHerdrClient(runner).tabList().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HerdrError);
    expect((err as HerdrError).code).toBe("invalid_response");
  });

  it("tabList throws invalid_response when a tab entry lacks a string tab_id", async () => {
    const { runner } = stubRunner([ok(JSON.stringify({ id: "cli:tab:list", result: { tabs: [{ workspace_id: "wC" }] } }))]);
    const err = await createHerdrClient(runner).tabList().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HerdrError);
    expect((err as HerdrError).code).toBe("invalid_response");
  });

  it("paneList bare spawns `pane list` and maps the pane's session", async () => {
    const { runner, calls } = stubRunner([ok(JSON.stringify({ id: "cli:pane:list", result: { panes: [RAW_PANE], type: "pane_list" } }))]);
    const panes = await createHerdrClient(runner).paneList();
    expect(calls).toEqual([["pane", "list"]]);
    expect(panes).toEqual([MAPPED_PANE]);
  });

  it("paneList scoped passes --workspace", async () => {
    const { runner, calls } = stubRunner([ok(JSON.stringify({ id: "cli:pane:list", result: { panes: [] } }))]);
    await createHerdrClient(runner).paneList("wC");
    expect(calls).toEqual([["pane", "list", "--workspace", "wC"]]);
  });

  it("paneList maps a plain shell pane to empty agent/sessionId instead of crashing", async () => {
    const shell = { pane_id: "wC:pX", workspace_id: "wC", tab_id: "wC:t9", cwd: "/tmp", agent_status: "idle" }; // no agent, no agent_session
    const { runner } = stubRunner([ok(JSON.stringify({ id: "cli:pane:list", result: { panes: [shell] } }))]);
    const panes = await createHerdrClient(runner).paneList();
    expect(panes[0]).toEqual({ id: "wC:pX", workspaceId: "wC", tabId: "wC:t9", agent: "", sessionId: "", cwd: "/tmp", status: "idle" });
  });

  it("paneList throws invalid_response when a pane entry lacks structural ids", async () => {
    const { runner } = stubRunner([ok(JSON.stringify({ id: "cli:pane:list", result: { panes: [{ pane_id: "wC:p1" }] } }))]); // no workspace_id/tab_id
    const err = await createHerdrClient(runner).paneList().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HerdrError);
    expect((err as HerdrError).code).toBe("invalid_response");
  });
});

describe("HerdrClient - DW-2.2/DW-2.4 error normalization (stubbed spawn, no live herdr)", () => {
  it("DW_2_2_spawn_failure_normalizes_to_HerdrError_spawn_failed", async () => {
    const runner: HerdrRunner = async () => {
      throw new Error("spawn herdr ENOENT");
    };
    const client = createHerdrClient(runner);

    const err = await client.agentList().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HerdrError);
    expect((err as HerdrError).code).toBe("spawn_failed");
    expect((err as HerdrError).message).toContain("ENOENT");
  });

  it("DW_2_2_nonzero_exit_with_json_error_body_on_stderr_normalizes_to_HerdrError_with_herdrs_own_code", async () => {
    // Verified live against herdr 0.7.5: `herdr agent get wZZ:pZZ` exits 1
    // with stdout EMPTY and this envelope on stderr. The previous version of
    // this test stubbed it on stdout, which herdr never does - that fiction
    // is why every typed code silently degraded to command_failed.
    const { runner } = stubRunner([
      fail(1, { stderr: `${JSON.stringify({ error: { code: "agent_not_found", message: "agent target w3:p1 not found" }, id: "cli:agent:get" })}\n` }),
    ]);
    const client = createHerdrClient(runner);

    const err = await client.agentGet("w3:p1").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HerdrError);
    expect((err as HerdrError).code).toBe("agent_not_found");
    expect((err as HerdrError).message).toBe("agent target w3:p1 not found");
  });

  it("DW_2_2_nonzero_exit_with_json_error_body_on_stdout_is_still_honoured", async () => {
    // Forward-compat guard, NOT observed behaviour: herdr 0.7.5 puts the
    // envelope on stderr. If a later build moves it to stdout, the lookup
    // must keep surfacing herdr's code rather than regressing to the text.
    const { runner } = stubRunner([
      fail(1, { stdout: JSON.stringify({ error: { code: "pane_not_found", message: "pane w3:p1 not found" }, id: "cli:pane:get" }) }),
    ]);
    const client = createHerdrClient(runner);

    const err = await client.paneGet("w3:p1").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HerdrError);
    expect((err as HerdrError).code).toBe("pane_not_found");
  });

  it("DW_2_2_nonzero_exit_with_plain_text_usage_error_normalizes_to_HerdrError_command_failed", async () => {
    // Verified live: `herdr agent list --bogus` -> exit 2, plain-text
    // `usage: herdr agent list` on stderr, stdout empty. Widening the
    // envelope lookup to stderr must NOT start treating this as an envelope.
    const { runner } = stubRunner([fail(2, { stderr: "usage: herdr agent list\n" })]);
    const client = createHerdrClient(runner);

    const err = await client.agentList().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HerdrError);
    expect((err as HerdrError).code).toBe("command_failed");
    expect((err as HerdrError).message).toContain("usage: herdr agent list");
  });

  it("DW_2_2_unknown_subcommand_plain_text_normalizes_to_HerdrError_not_a_raw_string_throw", async () => {
    // Verified live: `herdr foo` -> exit 2 (not 1), plain text on stderr.
    const { runner } = stubRunner([fail(2, { stderr: "unknown command: foo\nrun 'herdr --help' for usage\n" })]);
    const client = createHerdrClient(runner);

    const err = await client.agentList().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HerdrError);
    expect((err as HerdrError).code).toBe("command_failed");
    expect((err as HerdrError).message).toContain("unknown command: foo");
  });

  it("DW_2_2_nonzero_exit_with_non_envelope_json_free_text_stays_command_failed", async () => {
    // Verified live: `herdr agent read <t> --format json` -> exit 1 with
    // `Error: Custom { kind: Other, error: "invalid read format: json" }` on
    // stderr. Nonzero + stderr detail, but not an envelope - must not be
    // mistaken for one just because the lookup now reads stderr.
    const { runner } = stubRunner([
      fail(1, { stderr: 'Error: Custom { kind: Other, error: "invalid read format: json" }\n' }),
    ]);
    const client = createHerdrClient(runner);

    const err = await client.agentRead("w3:p1").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HerdrError);
    expect((err as HerdrError).code).toBe("command_failed");
    expect((err as HerdrError).message).toContain("invalid read format");
  });

  it("DW_2_2_malformed_partial_stdout_on_exit_0_normalizes_to_HerdrError_invalid_response", async () => {
    const { runner } = stubRunner([ok('{"id":"cli:agent:list","result":{"agents":[{"agent":"cla')]);
    const client = createHerdrClient(runner);

    const err = await client.agentList().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HerdrError);
    expect((err as HerdrError).code).toBe("invalid_response");
  });

  it("DW_2_2_empty_stdout_on_exit_0_normalizes_to_HerdrError_invalid_response", async () => {
    const { runner } = stubRunner([ok("")]);
    const client = createHerdrClient(runner);

    const err = await client.agentList().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HerdrError);
    expect((err as HerdrError).code).toBe("invalid_response");
  });

  it("DW_2_2_agentRead_raw_path_surfaces_herdrs_own_code_from_the_stderr_envelope", async () => {
    // Verified live against herdr 0.7.5: `herdr agent read wZZ:pZZ --lines 5`
    // exits 1 with stdout EMPTY and this envelope on stderr. The raw path
    // drops the SUCCESS parse only - the failure taxonomy is shared, so this
    // must land on herdr's own code exactly as the JSON path does.
    const envelope = JSON.stringify({ error: { code: "agent_not_found", message: "agent target wZZ:pZZ not found" }, id: "cli:agent:read" });
    const { runner, calls } = stubRunner([fail(1, { stderr: `${envelope}\n` })]);
    const client = createHerdrClient(runner);

    const err = await client.agentRead("wZZ:pZZ", { lines: 5 }).catch((e: unknown) => e);

    expect(calls).toEqual([["agent", "read", "wZZ:pZZ", "--lines", "5"]]);
    expect(err).toBeInstanceOf(HerdrError);
    expect((err as HerdrError).code).toBe("agent_not_found");
    expect((err as HerdrError).message).toBe("agent target wZZ:pZZ not found");
  });

  it("DW_2_2_agentRead_raw_path_still_normalizes_a_plain_text_failure_to_command_failed", async () => {
    const { runner } = stubRunner([fail(2, { stderr: "usage: herdr agent read <TARGET>\n" })]);
    const client = createHerdrClient(runner);

    const err = await client.agentRead("w3:p1").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HerdrError);
    expect((err as HerdrError).code).toBe("command_failed");
    expect((err as HerdrError).message).toContain("usage: herdr agent read");
  });

  it("DW_2_2_agentRead_raw_path_normalizes_a_spawn_failure_to_spawn_failed", async () => {
    const runner: HerdrRunner = async () => {
      throw new Error("spawn herdr ENOENT");
    };
    const client = createHerdrClient(runner);

    const err = await client.agentRead("w3:p1").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HerdrError);
    expect((err as HerdrError).code).toBe("spawn_failed");
  });

  it("DW_2_2_agentRead_empty_stdout_on_exit_0_is_an_empty_pane_not_an_invalid_response", async () => {
    // Unlike every JSON-returning method, empty stdout here is a legitimate
    // answer (nothing on screen) - it must not become invalid_response.
    const { runner } = stubRunner([ok("")]);
    const client = createHerdrClient(runner);

    expect(await client.agentRead("w3:p1")).toBe("");
  });

  it("DW_2_2_agentWait_timeout_envelope_normalizes_to_HerdrError_wait_timeout_not_herdrs_timeout", async () => {
    // Verified live against herdr 0.7.5 by waiting on an idle agent for a
    // status it never reaches: exit 1, stdout EMPTY, and this envelope on
    // stderr. Widening the lookup to stderr means it now arrives as herdr's
    // `timeout`, so the remap has to catch that code - otherwise this fix
    // would silently make `wait_timeout` unreachable.
    const envelope = JSON.stringify({ error: { code: "timeout", message: "timed out waiting for agent status" }, id: "cli:agent:wait" });
    const { runner, calls } = stubRunner([fail(1, { stderr: `${envelope}\n` })]);
    const client = createHerdrClient(runner);

    const err = await client.agentWait("w3:p1", { status: "working", timeoutMs: 200 }).catch((e: unknown) => e);

    expect(calls).toEqual([["agent", "wait", "w3:p1", "--until", "working", "--timeout", "200"]]);
    expect(err).toBeInstanceOf(HerdrError);
    expect((err as HerdrError).code).toBe("wait_timeout");
    expect((err as HerdrError).message).toBe("timed out waiting for agent status");
  });

  it("DW_2_2_agentWait_plain_text_timeout_without_an_envelope_is_still_wait_timeout", async () => {
    // Fallback, not observed on 0.7.5: a herdr build that reports the timeout
    // as plain text lands on command_failed, and the message sniff has to
    // keep catching it.
    const { runner } = stubRunner([fail(1, { stderr: "timed out waiting for agent status change\n" })]);
    const client = createHerdrClient(runner);

    const err = await client.agentWait("w3:p1", { status: "working" }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HerdrError);
    expect((err as HerdrError).code).toBe("wait_timeout");
  });

  it("DW_2_2_agentWait_timeout_message_in_stdout_is_still_classified_as_wait_timeout", async () => {
    const { runner } = stubRunner([fail(1, { stdout: "timed out waiting for agent status change\n" })]);
    const client = createHerdrClient(runner);

    const err = await client.agentWait("w3:p1", { status: "working" }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HerdrError);
    expect((err as HerdrError).code).toBe("wait_timeout");
  });

  it("DW_2_2_agentWait_non_timeout_command_failure_stays_command_failed", async () => {
    // A usage failure must not be read as a timeout. (This stub used to be
    // `unknown option: --status`, which was herdr rejecting the client's own
    // wrong flag - real, but a bug rather than a contract. The argv is
    // correct now, so the case is stated with generic usage text.)
    const { runner } = stubRunner([fail(2, { stderr: "usage: herdr agent wait <TARGET>\n" })]);
    const client = createHerdrClient(runner);

    const err = await client.agentWait("w3:p1", { status: "working" }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HerdrError);
    expect((err as HerdrError).code).toBe("command_failed");
  });

  it("DW_2_2_a_nonzero_exit_with_a_non_timeout_envelope_keeps_herdrs_code_through_agentWait", async () => {
    const envelope = JSON.stringify({ error: { code: "agent_not_found", message: "agent target w3:p1 not found" }, id: "cli:agent:wait" });
    const { runner } = stubRunner([fail(1, { stderr: `${envelope}\n` })]);
    const client = createHerdrClient(runner);

    const err = await client.agentWait("w3:p1", { status: "working" }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HerdrError);
    expect((err as HerdrError).code).toBe("agent_not_found");
  });
});

describe("HerdrClient - additional edge cases surfaced during implementation", () => {
  it("agentList tolerates a missing agent_session (defaults sessionId to empty string)", async () => {
    const rawWithoutSession = { ...RAW_AGENT, agent_session: undefined };
    const { runner } = stubRunner([ok(JSON.stringify({ id: "cli:agent:list", result: { agents: [rawWithoutSession] } }))]);
    const client = createHerdrClient(runner);

    const agents = await client.agentList();

    expect(agents[0]!.sessionId).toBe("");
  });

  it("agentList normalizes an unrecognized agent_status to 'unknown' instead of crashing", async () => {
    const rawWithWeirdStatus = { ...RAW_AGENT, agent_status: "zombie" };
    const { runner } = stubRunner([ok(JSON.stringify({ id: "cli:agent:list", result: { agents: [rawWithWeirdStatus] } }))]);
    const client = createHerdrClient(runner);

    const agents = await client.agentList();

    expect(agents[0]!.status).toBe("unknown");
  });

  it("workspaceList falls back to empty-string cwd (no crash) when a workspace has zero panes", async () => {
    const { runner } = stubRunner([
      ok(JSON.stringify({ id: "cli:workspace:list", result: { workspaces: [{ workspace_id: "wEmpty", label: null, tab_count: 0, pane_count: 0 }] } })),
      ok(JSON.stringify({ id: "cli:pane:list", result: { panes: [] } })),
    ]);
    const client = createHerdrClient(runner);

    const workspaces = await client.workspaceList();

    expect(workspaces).toEqual([{ id: "wEmpty", label: null, cwd: "", tabCount: 0, paneCount: 0 }]);
  });

  it("agentGet on an unexpected result shape (missing required fields) throws invalid_response instead of crashing on undefined access", async () => {
    const { runner } = stubRunner([ok(JSON.stringify({ id: "cli:agent:get", result: { agent: { agent: "claude" } } }))]);
    const client = createHerdrClient(runner);

    const err = await client.agentGet("w3:p1").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HerdrError);
    expect((err as HerdrError).code).toBe("invalid_response");
  });
});

describe("HerdrClient - coverage completion for defensive guards (review fix pass)", () => {
  it("unwrapResult throws invalid_response when the expected result key is absent (not merely falsy)", async () => {
    // result IS a record, but has no "agent" key at all - distinct from the
    // "agent" key being present with a malformed shape (covered above).
    const { runner } = stubRunner([ok(JSON.stringify({ id: "cli:agent:get", result: {} }))]);
    const client = createHerdrClient(runner);

    const err = await client.agentGet("w3:p1").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HerdrError);
    expect((err as HerdrError).code).toBe("invalid_response");
    expect((err as HerdrError).message).toContain("expected result.agent");
  });

  it("mapAgent throws invalid_response when an element of result.agents is not an object at all (e.g. a bare string)", async () => {
    const { runner } = stubRunner([ok(JSON.stringify({ id: "cli:agent:list", result: { agents: ["not-an-object"] } }))]);
    const client = createHerdrClient(runner);

    const err = await client.agentList().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HerdrError);
    expect((err as HerdrError).code).toBe("invalid_response");
    expect((err as HerdrError).message).toContain("expected an agent object");
  });

  it("mapWorkspaceFields throws invalid_response when the workspace object is malformed (missing string workspace_id)", async () => {
    const { runner } = stubRunner([
      ok(JSON.stringify({ id: "cli:workspace:create", result: { workspace: { label: "no-id" } } })),
    ]);
    const client = createHerdrClient(runner);

    const err = await client.workspaceCreate({ cwd: "/tmp/x" }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HerdrError);
    expect((err as HerdrError).code).toBe("invalid_response");
    expect((err as HerdrError).message).toContain("expected a workspace object");
  });

  it("agentList throws invalid_response when result.agents is present but not an array", async () => {
    const { runner } = stubRunner([ok(JSON.stringify({ id: "cli:agent:list", result: { agents: "not-an-array" } }))]);
    const client = createHerdrClient(runner);

    const err = await client.agentList().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HerdrError);
    expect((err as HerdrError).code).toBe("invalid_response");
    expect((err as HerdrError).message).toContain("expected result.agents to be an array");
  });

  // There is no agentRead guard to cover here any more: herdr never wraps
  // `agent read` in a `{result:{read:{text}}}` envelope (herdr 0.7.5 has no
  // json format for it), so the guard that asserted that shape was testing a
  // contract that does not exist. The raw path's real contract - verbatim
  // stdout on exit 0, herdr's own error code on a nonzero exit - is covered
  // in the DW-2.1 and DW-2.2 blocks above.

  it("workspaceList throws invalid_response when result.workspaces is present but not an array", async () => {
    const { runner } = stubRunner([ok(JSON.stringify({ id: "cli:workspace:list", result: { workspaces: "not-an-array" } }))]);
    const client = createHerdrClient(runner);

    const err = await client.workspaceList().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HerdrError);
    expect((err as HerdrError).code).toBe("invalid_response");
    expect((err as HerdrError).message).toContain("expected result.workspaces to be an array");
  });

  it("sessionList throws invalid_response when the body isn't the expected bare {sessions:[...]} shape", async () => {
    const { runner } = stubRunner([ok(JSON.stringify({ notSessions: [] }))]);
    const client = createHerdrClient(runner);

    const err = await client.sessionList().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HerdrError);
    expect((err as HerdrError).code).toBe("invalid_response");
    expect((err as HerdrError).message).toContain("expected a bare {sessions:[...]} body");
  });

  it("sessionList throws invalid_response when an individual session entry is missing name/default/running", async () => {
    const { runner } = stubRunner([ok(JSON.stringify({ sessions: [{ name: "default" }] }))]);
    const client = createHerdrClient(runner);

    const err = await client.sessionList().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HerdrError);
    expect((err as HerdrError).code).toBe("invalid_response");
    expect((err as HerdrError).message).toContain("sessions[0]");
  });
});
