// Unit tests for HerdrClient (src/herdr/client.ts) against a stubbed
// HerdrRunner - no real `herdr` process is ever spawned. Each test injects
// canned {stdout,stderr,exitCode} responses and asserts both the exact argv
// HerdrClient sent and the typed value/error it produced.

import { describe, expect, it } from "bun:test";
import { createHerdrClient, type HerdrRunResult, type HerdrRunner } from "../../src/herdr/client.js";
import { HerdrError, type Agent } from "../../src/herdr/types.js";

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

  it("DW_2_1_agentRead_spawns_agent_read_with_flags_and_returns_text", async () => {
    const { runner, calls } = stubRunner([
      ok(
        JSON.stringify({
          id: "cli:agent:read",
          result: { read: { format: "text", pane_id: "w3:p1", revision: 0, source: "recent", tab_id: "w3:t1", text: "hello\n", truncated: false, workspace_id: "w3" }, type: "pane_read" },
        }),
      ),
    ]);
    const client = createHerdrClient(runner);

    const text = await client.agentRead("w3:p1", { lines: 3, source: "recent" });

    expect(calls).toEqual([["agent", "read", "w3:p1", "--source", "recent", "--lines", "3"]]);
    expect(text).toBe("hello\n");
  });

  it("DW_2_1_agentWait_spawns_agent_wait_with_status_and_timeout_and_maps_result", async () => {
    const { runner, calls } = stubRunner([
      ok(JSON.stringify({ id: "cli:agent:wait:resolve", result: { agent: RAW_AGENT, type: "agent_info" } })),
    ]);
    const client = createHerdrClient(runner);

    const agent = await client.agentWait("w3:p1", { status: "idle", timeoutMs: 500 });

    expect(calls).toEqual([["agent", "wait", "w3:p1", "--status", "idle", "--timeout", "500"]]);
    expect(agent).toEqual(MAPPED_AGENT);
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

  it("DW_2_2_paneRun_nonzero_exit_with_no_json_still_raises_a_typed_command_failed_error", async () => {
    const { runner } = stubRunner([fail(1, { stderr: "pane not found" })]);
    const client = createHerdrClient(runner);

    const err = await client.paneRun("w9:p1", "echo hi").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HerdrError);
    expect((err as HerdrError).code).toBe("command_failed");
    expect((err as HerdrError).message).toContain("pane not found");
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

  it("DW_2_2_nonzero_exit_with_json_error_body_normalizes_to_HerdrError_with_herdrs_own_code", async () => {
    const { runner } = stubRunner([
      fail(1, { stdout: JSON.stringify({ error: { code: "agent_not_found", message: "agent target w3:p1 not found" }, id: "cli:agent:get" }) }),
    ]);
    const client = createHerdrClient(runner);

    const err = await client.agentGet("w3:p1").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HerdrError);
    expect((err as HerdrError).code).toBe("agent_not_found");
    expect((err as HerdrError).message).toBe("agent target w3:p1 not found");
  });

  it("DW_2_2_nonzero_exit_with_plain_text_usage_error_normalizes_to_HerdrError_command_failed", async () => {
    // Verified live: passing an unsupported flag/subcommand form produces
    // plain-text `usage: ...` on exit 2, not JSON.
    const { runner } = stubRunner([fail(2, { stdout: "usage: herdr agent list\n" })]);
    const client = createHerdrClient(runner);

    const err = await client.agentList().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HerdrError);
    expect((err as HerdrError).code).toBe("command_failed");
    expect((err as HerdrError).message).toContain("usage: herdr agent list");
  });

  it("DW_2_2_unknown_subcommand_plain_text_normalizes_to_HerdrError_not_a_raw_string_throw", async () => {
    // Verified live: `herdr foo` -> exit 1, plain text "unknown command: foo".
    const { runner } = stubRunner([fail(1, { stderr: "unknown command: foo\nrun 'herdr --help' for usage\n" })]);
    const client = createHerdrClient(runner);

    const err = await client.agentList().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HerdrError);
    expect((err as HerdrError).code).toBe("command_failed");
    expect((err as HerdrError).message).toContain("unknown command: foo");
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

  it("DW_2_2_agentWait_timeout_normalizes_to_HerdrError_wait_timeout_not_command_failed", async () => {
    // Verified live: `herdr agent wait ... --timeout 200` on an agent whose
    // status never changes -> exit 1, plain text "timed out waiting for
    // agent status change" (not JSON).
    const { runner, calls } = stubRunner([fail(1, { stderr: "timed out waiting for agent status change\n" })]);
    const client = createHerdrClient(runner);

    const err = await client.agentWait("w3:p1", { status: "working", timeoutMs: 200 }).catch((e: unknown) => e);

    expect(calls).toEqual([["agent", "wait", "w3:p1", "--status", "working", "--timeout", "200"]]);
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
    const { runner } = stubRunner([fail(2, { stdout: "usage: herdr agent wait\n" })]);
    const client = createHerdrClient(runner);

    const err = await client.agentWait("w3:p1", { status: "working" }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HerdrError);
    expect((err as HerdrError).code).toBe("command_failed");
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

  it("agentRead throws invalid_response when result.read.text is present but not a string", async () => {
    const { runner } = stubRunner([
      ok(JSON.stringify({ id: "cli:agent:read", result: { read: { text: 12345 } } })),
    ]);
    const client = createHerdrClient(runner);

    const err = await client.agentRead("w3:p1").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HerdrError);
    expect((err as HerdrError).code).toBe("invalid_response");
    expect((err as HerdrError).message).toContain("expected result.read.text to be a string");
  });

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
