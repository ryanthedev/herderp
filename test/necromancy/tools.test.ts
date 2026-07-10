// Unit tests for the necromancy MCP tools (src/tools/necromancy.ts) - DW-3.6.
// Registers on a bare McpServer with a stub Necromancy core (same style as
// test/herdr/curated.test.ts).

import { describe, expect, it } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerNecromancyTools } from "../../src/tools/necromancy.js";
import { NecromancyError, type Necromancy, type ReviveResult, type SessionInfo, type SpaceInfo } from "../../src/necromancy/core.js";

const STUB_SPACE: SpaceInfo = { cwd: "/tmp/proj", label: "alpha", workspaceId: "w1", sessionCount: 2, lastActivity: 1720000000000 };
const STUB_SESSION: SessionInfo = { id: "11111111-1111-1111-1111-111111111111", cwd: "/tmp/proj", mtime: 1720000000000, live: false, preview: "fixing things", messageCount: 4 };
const STUB_REVIVE: ReviveResult = { workspaceId: "w9", paneId: "w9:p1", sessionId: STUB_SESSION.id, detected: true };

function stubNecromancy(overrides: Partial<Necromancy> = {}): Necromancy {
  return {
    findSpaces: async () => [STUB_SPACE],
    listSessions: async () => [STUB_SESSION],
    revive: async () => STUB_REVIVE,
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

describe("registerNecromancyTools - DW-3.6", () => {
  it("DW_3_6_three_necromancy_tools_present_with_input_schemas", () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerNecromancyTools(server, stubNecromancy());

    const tools = registeredTools(server);
    for (const name of ["necromancy_find_spaces", "necromancy_list_sessions", "necromancy_revive"]) {
      expect(tools[name]).toBeDefined();
      expect(tools[name]!.description.length).toBeGreaterThan(0);
      expect(tools[name]!.inputSchema).toBeDefined();
    }
  });

  it("DW_3_6_necromancy_find_spaces_returns_the_cores_spaces", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerNecromancyTools(server, stubNecromancy());

    const result = await registeredTools(server).necromancy_find_spaces!.handler({}, {});

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0]!.text)).toEqual({ spaces: [STUB_SPACE] });
  });

  it("DW_3_6_necromancy_list_sessions_passes_the_space_through_to_the_core", async () => {
    let received: unknown;
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerNecromancyTools(
      server,
      stubNecromancy({
        listSessions: async (cwd) => {
          received = cwd;
          return [STUB_SESSION];
        },
      }),
    );

    const result = await registeredTools(server).necromancy_list_sessions!.handler({ space: "/tmp/proj" }, {});

    expect(received).toBe("/tmp/proj");
    expect(JSON.parse(result.content[0]!.text)).toEqual({ sessions: [STUB_SESSION] });
  });

  it("DW_3_6_necromancy_revive_passes_sessionId_and_cwd_and_returns_the_seam_object", async () => {
    let received: unknown;
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerNecromancyTools(
      server,
      stubNecromancy({
        revive: async (req) => {
          received = req;
          return STUB_REVIVE;
        },
      }),
    );

    const result = await registeredTools(server).necromancy_revive!.handler(
      { sessionId: STUB_SESSION.id, cwd: "/tmp/proj" },
      {},
    );

    expect(received).toEqual({ sessionId: STUB_SESSION.id, cwd: "/tmp/proj" });
    expect(JSON.parse(result.content[0]!.text)).toEqual({ ...STUB_REVIVE });
  });

  it("DW_3_6_a_thrown_NecromancyError_surfaces_as_isError_not_a_crash", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerNecromancyTools(
      server,
      stubNecromancy({
        revive: async () => {
          throw new NecromancyError("invalid_session_id", 'session id is not a UUID: "nope"');
        },
      }),
    );

    const result = await registeredTools(server).necromancy_revive!.handler({ sessionId: "nope", cwd: "/tmp/proj" }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("not a UUID");
  });
});
