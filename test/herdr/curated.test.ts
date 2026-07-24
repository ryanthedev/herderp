// Unit tests for the curated MCP tools (src/tools/curated.ts).
// Registers on a bare McpServer with a stub HerdrClient (no real herdr
// process, no stdio transport needed - same style as test/registry.test.ts).
//
// Handlers are invoked directly, which bypasses the SDK's zod layer. That is
// deliberate here: it exercises the tools' OWN per-action validation (the
// `need`/renameTarget guards), which is what has to catch a wrong field now
// that one tool covers many actions and the schema cannot mark fields
// required per-action.

import { describe, expect, it } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCuratedTools } from "../../src/tools/curated.js";
import type { HerdrClient } from "../../src/herdr/client.js";
import type { Agent, Pane, Session, Tab, Workspace, Worktree } from "../../src/herdr/types.js";

const STUB_AGENT: Agent = {
  agent: "claude",
  sessionId: "session-1",
  status: "idle",
  cwd: "/tmp/proj",
  workspaceId: "w1",
  tabId: "w1:t1",
  paneId: "w1:p1",
};

const STUB_WORKSPACE: Workspace = { id: "w9", label: "foo", cwd: "/tmp/x", tabCount: 1, paneCount: 1 };
/** workspaceCreate's richer return shape (Phase 3 seam addendum). */
const STUB_CREATED_WORKSPACE = { ...STUB_WORKSPACE, rootPaneId: "w9:p1" };
const STUB_SESSION: Session = { name: "default", default: true, running: true };
const STUB_TAB: Tab = { id: "w1:t1", workspaceId: "w1", label: "1", number: 3, focused: true };
const STUB_PANE: Pane = {
  id: "w1:p1",
  workspaceId: "w1",
  tabId: "w1:t1",
  agent: "claude",
  sessionId: "session-1",
  cwd: "/tmp/proj",
  status: "idle",
};
const STUB_WORKTREE: Worktree = {
  path: "/tmp/wt",
  branch: "feature/x",
  label: null,
  isBare: false,
  isDetached: false,
  isLinkedWorktree: true,
  isPrunable: false,
  openWorkspaceId: "",
};

/** A complete HerdrClient whose every method succeeds trivially. Tests
 * override only the one method they assert on, so adding a client method
 * never forces an edit to unrelated tests. */
function stubClient(overrides: Partial<HerdrClient> = {}): HerdrClient {
  return {
    agentList: async () => [STUB_AGENT],
    agentGet: async () => STUB_AGENT,
    agentRead: async () => "pane output",
    agentWait: async () => STUB_AGENT,
    agentSend: async () => undefined,
    agentFocus: async () => undefined,
    agentRename: async () => undefined,
    agentStart: async () => undefined,
    agentExplain: async () => ({ state: "idle" }),
    workspaceList: async () => [STUB_WORKSPACE],
    workspaceCreate: async () => STUB_CREATED_WORKSPACE,
    workspaceFocus: async () => undefined,
    workspaceGet: async () => STUB_WORKSPACE,
    workspaceRename: async () => undefined,
    workspaceClose: async () => undefined,
    paneRun: async () => undefined,
    paneClose: async () => undefined,
    paneGet: async () => STUB_PANE,
    paneRename: async () => undefined,
    paneFocusDirection: async () => undefined,
    paneSplit: async () => undefined,
    paneSwap: async () => undefined,
    paneMove: async () => undefined,
    sessionList: async () => [STUB_SESSION],
    tabList: async () => [STUB_TAB],
    tabGet: async () => STUB_TAB,
    tabCreate: async () => STUB_TAB,
    tabRename: async () => undefined,
    tabFocus: async () => undefined,
    tabClose: async () => undefined,
    paneList: async () => [STUB_PANE],
    worktreeList: async () => [STUB_WORKTREE],
    worktreeCreate: async () => undefined,
    worktreeOpen: async () => undefined,
    worktreeRemove: async () => undefined,
    ...overrides,
  };
}

type RegisteredTool = {
  description: string;
  inputSchema?: unknown;
  handler: (args: unknown, extra: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
};

function registeredTools(server: McpServer): Record<string, RegisteredTool> {
  return (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools;
}

function withTools(overrides: Partial<HerdrClient> = {}): Record<string, RegisteredTool> {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerCuratedTools(server, stubClient(overrides));
  return registeredTools(server);
}

/** Invokes a tool. Success bodies are JSON; registerTool renders a thrown
 * error as PLAIN TEXT, so `body` is left empty in that case rather than
 * exploding on JSON.parse - error assertions use `text`. */
async function call(tools: Record<string, RegisteredTool>, name: string, args: unknown) {
  const result = await tools[name]!.handler(args, {});
  const text = result.content[0]!.text;
  const body = result.isError ? {} : (JSON.parse(text) as Record<string, unknown>);
  return { isError: result.isError, body, text, raw: result };
}

const EXPECTED_TOOL_NAMES = [
  "herdr_agent",
  "herdr_pane",
  "herdr_tab",
  "herdr_workspace",
  "herdr_worktree",
  "herdr_session_list",
] as const;

describe("registerCuratedTools - resource+action tool surface", () => {
  it("registers exactly the six curated tools, each with a description and schema", () => {
    const tools = withTools();
    for (const name of EXPECTED_TOOL_NAMES) {
      expect(tools[name]).toBeDefined();
      expect(tools[name]!.description.length).toBeGreaterThan(0);
      expect(tools[name]!.inputSchema).toBeDefined();
    }
    // The collapse is the point: no per-subcommand tools should survive.
    expect(tools.herdr_agent_list).toBeUndefined();
    expect(tools.herdr_pane_run).toBeUndefined();
    expect(tools.herdr_workspace_create).toBeUndefined();
  });

  it("dispatches herdr_agent actions to the matching client method", async () => {
    const tools = withTools();
    expect((await call(tools, "herdr_agent", { action: "list" })).body.agents).toEqual([STUB_AGENT]);
    expect((await call(tools, "herdr_agent", { action: "get", target: "w1:p1" })).body.agent).toEqual(STUB_AGENT);
    expect((await call(tools, "herdr_agent", { action: "read", target: "w1:p1" })).body.text).toBe("pane output");
    expect((await call(tools, "herdr_agent", { action: "explain", target: "w1:p1" })).body.explain).toEqual({
      state: "idle",
    });
  });

  it("passes agent read options and wait options straight through", async () => {
    let read: unknown;
    let wait: unknown;
    const tools = withTools({
      agentRead: async (target, opts) => {
        read = { target, opts };
        return "pane output";
      },
      agentWait: async (target, opts) => {
        wait = { target, opts };
        return STUB_AGENT;
      },
    });

    await call(tools, "herdr_agent", { action: "read", target: "w1:p1", source: "recent", lines: 5 });
    await call(tools, "herdr_agent", { action: "wait", target: "w1:p1", status: "working", timeoutMs: 1000 });

    expect(read).toEqual({
      target: "w1:p1",
      opts: { source: "recent", lines: 5, format: undefined, ansi: undefined },
    });
    expect(wait).toEqual({ target: "w1:p1", opts: { status: "working", timeoutMs: 1000 } });
  });

  it("agent send passes literal text and does not claim to have pressed Enter", async () => {
    let sent: unknown;
    const tools = withTools({
      agentSend: async (target, text) => {
        sent = { target, text };
      },
    });
    const { body } = await call(tools, "herdr_agent", { action: "send", target: "w1:p1", text: "hello" });

    expect(sent).toEqual({ target: "w1:p1", text: "hello" });
    expect(body.ok).toBe(true);
    expect(String(body.hint)).toContain("no Enter");
  });

  it("agent rename sends the new name, and clear:true sends null", async () => {
    const calls: Array<[string, string | null]> = [];
    const tools = withTools({
      agentRename: async (target, name) => {
        calls.push([target, name]);
      },
    });

    await call(tools, "herdr_agent", { action: "rename", target: "w1:p1", name: "reviewer" });
    await call(tools, "herdr_agent", { action: "rename", target: "w1:p1", clear: true });

    expect(calls).toEqual([
      ["w1:p1", "reviewer"],
      ["w1:p1", null],
    ]);
  });

  it("agent rename rejects name and clear together, naming the conflict", async () => {
    const tools = withTools();
    const { isError, text } = await call(tools, "herdr_agent", {
      action: "rename",
      target: "w1:p1",
      name: "x",
      clear: true,
    });
    expect(isError).toBe(true);
    expect(text).toContain('either "name" or "clear"');
  });

  it("agent start requires a non-empty argv and forwards it", async () => {
    let started: unknown;
    const tools = withTools({
      agentStart: async (opts) => {
        started = opts;
      },
    });

    const missing = await call(tools, "herdr_agent", { action: "start", name: "worker" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("argv");

    await call(tools, "herdr_agent", { action: "start", name: "worker", argv: ["claude"], cwd: "/tmp/p" });
    expect(started).toMatchObject({ name: "worker", argv: ["claude"], cwd: "/tmp/p" });
  });

  it("a missing required field names the tool, the action and the field", async () => {
    const tools = withTools();
    const { isError, text } = await call(tools, "herdr_agent", { action: "get" });
    expect(isError).toBe(true);
    expect(text).toBe('herdr_agent{action:"get"} requires "target"');
  });

  it("a thrown HerdrError from the client surfaces as isError, not a crash", async () => {
    const tools = withTools({
      agentGet: async () => {
        throw new Error("agent target bogus not found");
      },
    });
    const { isError, text } = await call(tools, "herdr_agent", { action: "get", target: "bogus" });
    expect(isError).toBe(true);
    expect(text).toContain("agent target bogus not found");
  });

  it("pane run submits the command and pane focus is directional, anchored on current by default", async () => {
    let ran: unknown;
    let focused: unknown;
    const tools = withTools({
      paneRun: async (paneId, command) => {
        ran = { paneId, command };
      },
      paneFocusDirection: async (direction, paneId) => {
        focused = { direction, paneId };
      },
    });

    await call(tools, "herdr_pane", { action: "run", paneId: "w1:p1", command: "echo hi" });
    await call(tools, "herdr_pane", { action: "focus", direction: "left" });

    expect(ran).toEqual({ paneId: "w1:p1", command: "echo hi" });
    expect(focused).toEqual({ direction: "left", paneId: undefined });
  });

  it("pane move forwards splitDirection as the client's split field", async () => {
    let moved: unknown;
    const tools = withTools({
      paneMove: async (opts) => {
        moved = opts;
      },
    });
    await call(tools, "herdr_pane", {
      action: "move",
      paneId: "w1:p1",
      destination: "tab",
      tabId: "w1:t2",
      splitDirection: "right",
    });
    expect(moved).toMatchObject({ paneId: "w1:p1", destination: "tab", tabId: "w1:t2", split: "right" });
  });

  it("tab rename requires a label (herdr's tab rename has no --clear)", async () => {
    const tools = withTools();
    const { isError, text } = await call(tools, "herdr_tab", { action: "rename", tabId: "w1:t1" });
    expect(isError).toBe(true);
    expect(text).toBe('herdr_tab{action:"rename"} requires "label"');
  });

  it("tab create returns the created tab when herdr supplies one, and degrades to null otherwise", async () => {
    const withTab = await call(withTools(), "herdr_tab", { action: "create" });
    expect(withTab.body.tab).toEqual(STUB_TAB as unknown as Record<string, unknown>);

    const withoutTab = await call(withTools({ tabCreate: async () => null }), "herdr_tab", { action: "create" });
    expect(withoutTab.isError).toBeFalsy();
    expect(withoutTab.body.ok).toBe(true);
    expect(String(withoutTab.body.hint)).toContain("list");
  });

  it("workspace create returns the root pane id in its hint so the next call is obvious", async () => {
    const { body } = await call(withTools(), "herdr_workspace", { action: "create", cwd: "/tmp/y" });
    expect(body.workspace).toMatchObject({ rootPaneId: "w9:p1" });
    expect(String(body.hint)).toContain("w9:p1");
  });

  it("worktree list warns when the call is unscoped, since herdr resolves against the focused workspace", async () => {
    const tools = withTools();

    const unscoped = await call(tools, "herdr_worktree", { action: "list" });
    expect(String(unscoped.body.hint)).toContain("FOCUSED");

    const scoped = await call(tools, "herdr_worktree", { action: "list", cwd: "/tmp/proj" });
    expect(String(scoped.body.hint)).not.toContain("FOCUSED");
    expect(scoped.body.worktrees).toEqual([STUB_WORKTREE as unknown as Record<string, unknown>]);
  });

  it("worktree scope is forwarded to the client", async () => {
    let scope: unknown;
    const tools = withTools({
      worktreeList: async (s) => {
        scope = s;
        return [STUB_WORKTREE];
      },
    });
    await call(tools, "herdr_worktree", { action: "list", workspaceId: "w1" });
    expect(scope).toEqual({ workspaceId: "w1", cwd: undefined });
  });

  it("herdr_session_list returns typed sessions and stays a plain single-purpose tool", async () => {
    const { body } = await call(withTools(), "herdr_session_list", {});
    expect(body).toEqual({ sessions: [STUB_SESSION as unknown as Record<string, unknown>] });
  });
});
