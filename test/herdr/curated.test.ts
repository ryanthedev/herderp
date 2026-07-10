// Unit tests for the curated MCP tools (src/tools/curated.ts) - DW-2.3.
// Registers on a bare McpServer with a stub HerdrClient (no real herdr
// process, no stdio transport needed - same style as test/registry.test.ts).

import { describe, expect, it } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCuratedTools } from "../../src/tools/curated.js";
import type { HerdrClient } from "../../src/herdr/client.js";
import type { Agent, Session, Workspace } from "../../src/herdr/types.js";

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
const STUB_SESSION: Session = { name: "default", default: true, running: true };

function stubClient(overrides: Partial<HerdrClient> = {}): HerdrClient {
  return {
    agentList: async () => [STUB_AGENT],
    agentGet: async () => STUB_AGENT,
    agentRead: async () => "pane output",
    agentWait: async () => STUB_AGENT,
    workspaceList: async () => [STUB_WORKSPACE],
    workspaceCreate: async () => STUB_WORKSPACE,
    workspaceFocus: async () => undefined,
    paneRun: async () => undefined,
    paneClose: async () => undefined,
    sessionList: async () => [STUB_SESSION],
    ...overrides,
  };
}

type RegisteredTool = { description: string; inputSchema?: unknown; handler: (args: unknown, extra: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> };

function registeredTools(server: McpServer): Record<string, RegisteredTool> {
  return (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools;
}

const EXPECTED_TOOL_NAMES = [
  "herdr_agent_list",
  "herdr_agent_get",
  "herdr_agent_read",
  "herdr_agent_wait",
  "herdr_workspace_create",
  "herdr_workspace_focus",
  "herdr_pane_run",
  "herdr_pane_close",
  "herdr_session_list",
] as const;

describe("registerCuratedTools - DW-2.3 curated tools present with input schemas", () => {
  it("DW_2_3_registers_every_curated_tool_with_a_non_empty_input_schema", () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerCuratedTools(server, stubClient());

    const tools = registeredTools(server);
    for (const name of EXPECTED_TOOL_NAMES) {
      expect(tools[name]).toBeDefined();
      expect(tools[name]!.description.length).toBeGreaterThan(0);
      expect(tools[name]!.inputSchema).toBeDefined();
    }
  });

  it("DW_2_3_herdr_agent_list_calls_the_client_and_returns_typed_agents_via_the_registerTool_wrapper", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerCuratedTools(server, stubClient());

    const tool = registeredTools(server).herdr_agent_list!;
    const result = await tool.handler({}, {});

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0]!.text)).toEqual({ agents: [STUB_AGENT] });
  });

  it("DW_2_3_herdr_agent_wait_passes_status_and_timeoutMs_through_to_the_client", async () => {
    let received: unknown;
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerCuratedTools(
      server,
      stubClient({
        agentWait: async (target, opts) => {
          received = { target, opts };
          return STUB_AGENT;
        },
      }),
    );

    const tool = registeredTools(server).herdr_agent_wait!;
    await tool.handler({ target: "w1:p1", status: "working", timeoutMs: 1000 }, {});

    expect(received).toEqual({ target: "w1:p1", opts: { status: "working", timeoutMs: 1000 } });
  });

  it("DW_2_3_a_thrown_HerdrError_from_the_client_surfaces_as_isError_not_a_crash", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerCuratedTools(
      server,
      stubClient({
        agentGet: async () => {
          throw new Error("agent target bogus not found");
        },
      }),
    );

    const tool = registeredTools(server).herdr_agent_get!;
    const result = await tool.handler({ target: "bogus" }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("agent target bogus not found");
  });

  it("DW_2_3_herdr_workspace_focus_and_pane_run_and_pane_close_return_an_ok_ack", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerCuratedTools(server, stubClient());
    const tools = registeredTools(server);

    for (const [name, args] of [
      ["herdr_workspace_focus", { id: "w1" }],
      ["herdr_pane_run", { paneId: "w1:p1", command: "echo hi" }],
      ["herdr_pane_close", { paneId: "w1:p1" }],
    ] as const) {
      const result = await tools[name]!.handler(args, {});
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(result.content[0]!.text)).toEqual({ ok: true });
    }
  });

  it("DW_2_3_herdr_session_list_returns_typed_sessions", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerCuratedTools(server, stubClient());

    const tool = registeredTools(server).herdr_session_list!;
    const result = await tool.handler({}, {});

    expect(JSON.parse(result.content[0]!.text)).toEqual({ sessions: [STUB_SESSION] });
  });

  it("DW_2_3_herdr_agent_read_passes_target_and_options_through_to_the_client_and_returns_text", async () => {
    let received: unknown;
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerCuratedTools(
      server,
      stubClient({
        agentRead: async (target, opts) => {
          received = { target, opts };
          return "pane output";
        },
      }),
    );

    const tool = registeredTools(server).herdr_agent_read!;
    const result = await tool.handler({ target: "w1:p1", source: "recent", lines: 5 }, {});

    expect(received).toEqual({ target: "w1:p1", opts: { source: "recent", lines: 5 } });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0]!.text)).toEqual({ text: "pane output" });
  });

  it("DW_2_3_herdr_workspace_create_passes_options_through_to_the_client_and_returns_the_typed_workspace", async () => {
    let received: unknown;
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerCuratedTools(
      server,
      stubClient({
        workspaceCreate: async (opts) => {
          received = opts;
          return STUB_WORKSPACE;
        },
      }),
    );

    const tool = registeredTools(server).herdr_workspace_create!;
    const result = await tool.handler({ cwd: "/tmp/y", label: "bar", focus: true }, {});

    expect(received).toEqual({ cwd: "/tmp/y", label: "bar", focus: true });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0]!.text)).toEqual(STUB_WORKSPACE);
  });
});
