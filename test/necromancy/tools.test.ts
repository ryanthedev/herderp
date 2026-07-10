// Unit tests for the necromancy MCP tools (src/tools/necromancy.ts) -
// DW-3.6 (find_spaces/list_sessions) and DW-2.1/DW-2.2 (the Phase 2
// reader tools: outline/search/read). Registers on a bare McpServer with a
// stub Necromancy core (same style as test/herdr/curated.test.ts); the
// DW-2.2 integration test instead drives a real createNecromancy() over a
// fixture session file through the real registry, exercising outline,
// search, and read end to end with no core stubbing.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerNecromancyTools } from "../../src/tools/necromancy.js";
import {
  createNecromancy,
  deriveSlug,
  NecromancyError,
  type Necromancy,
  type SessionInfo,
  type SpaceInfo,
} from "../../src/necromancy/core.js";
import { DEFAULT_MAX_OUTLINE_ENTRIES, DEFAULT_MAX_READ_BYTES, DEFAULT_MAX_SEARCH_MATCHES } from "../../src/necromancy/reader.js";
import type { HerdrClient } from "../../src/herdr/client.js";

const STUB_SPACE: SpaceInfo = { cwd: "/tmp/proj", label: "alpha", workspaceId: "w1", sessionCount: 2, lastActivity: 1720000000000 };
const STUB_SESSION: SessionInfo = { id: "11111111-1111-1111-1111-111111111111", cwd: "/tmp/proj", mtime: 1720000000000, live: false, preview: "fixing things", messageCount: 4 };

/** Phase 1 (necromancy core) added sessionOutline/sessionSearch/sessionRead
 * to the Necromancy factory type; the find_spaces/list_sessions tests here
 * don't exercise them, so those three are stubbed "unexpected call" purely to
 * satisfy the type. */
function stubNecromancy(overrides: Partial<Necromancy> = {}): Necromancy {
  const unexpected = (name: string) => async () => {
    throw new Error(`unexpected necromancy call: ${name}`);
  };
  return {
    findSpaces: async () => [STUB_SPACE],
    listSessions: async () => [STUB_SESSION],
    sessionOutline: unexpected("sessionOutline"),
    sessionSearch: unexpected("sessionSearch"),
    sessionRead: unexpected("sessionRead"),
    ...overrides,
  } as Necromancy;
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
  it("DW_3_6_necromancy_space_tools_present_with_input_schemas", () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerNecromancyTools(server, stubNecromancy());

    const tools = registeredTools(server);
    for (const name of ["necromancy_find_spaces", "necromancy_list_sessions"]) {
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

});

// ---------------------------------------------------------------------------
// necromancy_outline / necromancy_search / necromancy_read - DW-2.1
// ---------------------------------------------------------------------------

const STUB_OUTLINE = { entries: [{ index: 0, role: "user" as const, preview: "hi" }], total: 1, nextOffset: null };
const STUB_SEARCH = { matches: [{ index: 0, role: "user" as const, snippet: "hi" }], truncated: false };
const STUB_READ = { entries: [{ index: 0, role: "user" as const, text: "hi" }], truncated: false };

describe("registerNecromancyTools reader tools - DW-2.1", () => {
  it("DW_2_1_three_reader_tools_present_with_input_schemas", () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerNecromancyTools(server, stubNecromancy());

    const tools = registeredTools(server);
    for (const name of ["necromancy_outline", "necromancy_search", "necromancy_read"]) {
      expect(tools[name]).toBeDefined();
      expect(tools[name]!.description.length).toBeGreaterThan(0);
      expect(tools[name]!.inputSchema).toBeDefined();
    }
  });

  it("DW_2_1_necromancy_outline_is_a_thin_passthrough_to_the_core", async () => {
    let received: unknown;
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerNecromancyTools(
      server,
      stubNecromancy({
        sessionOutline: async (args) => {
          received = args;
          return STUB_OUTLINE;
        },
      }),
    );

    const result = await registeredTools(server).necromancy_outline!.handler(
      { sessionId: STUB_SESSION.id, cwd: "/tmp/proj", offset: 5, limit: 10, filter: "tool_use" },
      {},
    );

    expect(received).toEqual({ sessionId: STUB_SESSION.id, cwd: "/tmp/proj", offset: 5, limit: 10, filter: "tool_use" });
    expect(JSON.parse(result.content[0]!.text)).toEqual(STUB_OUTLINE);
  });

  it("DW_2_1_necromancy_search_is_a_thin_passthrough_to_the_core", async () => {
    let received: unknown;
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerNecromancyTools(
      server,
      stubNecromancy({
        sessionSearch: async (args) => {
          received = args;
          return STUB_SEARCH;
        },
      }),
    );

    const result = await registeredTools(server).necromancy_search!.handler(
      { sessionId: STUB_SESSION.id, cwd: "/tmp/proj", query: "hi", limit: 5, regex: false },
      {},
    );

    expect(received).toEqual({ sessionId: STUB_SESSION.id, cwd: "/tmp/proj", query: "hi", limit: 5, regex: false });
    expect(JSON.parse(result.content[0]!.text)).toEqual(STUB_SEARCH);
  });

  it("DW_2_1_necromancy_read_is_a_thin_passthrough_to_the_core", async () => {
    let received: unknown;
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerNecromancyTools(
      server,
      stubNecromancy({
        sessionRead: async (args) => {
          received = args;
          return STUB_READ;
        },
      }),
    );

    const result = await registeredTools(server).necromancy_read!.handler(
      { sessionId: STUB_SESSION.id, cwd: "/tmp/proj", from: 0, to: 2, maxBytes: 1024 },
      {},
    );

    expect(received).toEqual({ sessionId: STUB_SESSION.id, cwd: "/tmp/proj", from: 0, to: 2, maxBytes: 1024 });
    expect(JSON.parse(result.content[0]!.text)).toEqual(STUB_READ);
  });

  it("DW_2_1_a_thrown_NecromancyError_from_any_reader_tool_surfaces_as_isError_not_a_crash", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerNecromancyTools(
      server,
      stubNecromancy({
        sessionOutline: async () => {
          throw new NecromancyError("session_not_found", "no session file for nope in space /tmp/proj");
        },
      }),
    );

    const result = await registeredTools(server).necromancy_outline!.handler(
      { sessionId: "not-a-uuid", cwd: "/tmp/proj" },
      {},
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("no session file");
  });

  it("DW_2_1_an_over_large_requested_limit_or_maxBytes_is_rejected_by_the_input_schema", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerNecromancyTools(server, stubNecromancy());
    const tools = registeredTools(server);

    // McpServer stores each tool's inputSchema already built into a full
    // ZodObject (see the SDK's getZodSchemaObject/objectFromShape), so these
    // are used directly rather than re-wrapped.
    type Parseable = { safeParse: (value: unknown) => { success: boolean } };
    const outlineSchema = tools.necromancy_outline!.inputSchema as unknown as Parseable;
    const searchSchema = tools.necromancy_search!.inputSchema as unknown as Parseable;
    const readSchema = tools.necromancy_read!.inputSchema as unknown as Parseable;

    // Within-ceiling values parse fine...
    expect(outlineSchema.safeParse({ sessionId: "x", cwd: "/y", limit: DEFAULT_MAX_OUTLINE_ENTRIES }).success).toBe(true);
    expect(searchSchema.safeParse({ sessionId: "x", cwd: "/y", query: "q", limit: DEFAULT_MAX_SEARCH_MATCHES }).success).toBe(true);
    expect(readSchema.safeParse({ sessionId: "x", cwd: "/y", from: 0, maxBytes: DEFAULT_MAX_READ_BYTES }).success).toBe(true);

    // ...but one over the ceiling is rejected before any handler runs, so a
    // tool call can never request an unbounded slice.
    expect(outlineSchema.safeParse({ sessionId: "x", cwd: "/y", limit: DEFAULT_MAX_OUTLINE_ENTRIES + 1 }).success).toBe(false);
    expect(searchSchema.safeParse({ sessionId: "x", cwd: "/y", query: "q", limit: DEFAULT_MAX_SEARCH_MATCHES + 1 }).success).toBe(false);
    expect(readSchema.safeParse({ sessionId: "x", cwd: "/y", from: 0, maxBytes: DEFAULT_MAX_READ_BYTES + 1 }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// outline -> search -> read integration over a real fixture session - DW-2.2
// ---------------------------------------------------------------------------

describe("necromancy reader tools integration (real core, real registry) - DW-2.2", () => {
  let root: string;
  const CWD = "/tmp/necromancy-fixture-proj";
  const SESSION_ID = "11111111-1111-1111-1111-111111111111";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "necromancy-tools-test-"));
    const dir = join(root, deriveSlug(CWD));
    await mkdir(dir, { recursive: true });
    const jl = (value: unknown): string => `${JSON.stringify(value)}\n`;
    const content =
      jl({ type: "user", message: { content: "please fix the flaky login test" }, cwd: CWD }) +
      jl({
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "let me check the test file first" },
            { type: "tool_use", id: "call_1", name: "Bash", input: { command: "cat login.test.ts" } },
          ],
        },
      }) +
      jl({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "call_1", content: "flaky assertion on line 42" }] },
      }) +
      jl({ type: "assistant", message: { content: [{ type: "text", text: "found it: a race condition on line 42" }] } });
    await writeFile(join(dir, `${SESSION_ID}.jsonl`), content);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

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
    } as HerdrClient;
  }

  it("DW_2_2_outline_search_read_integration_over_a_fixture_session_via_the_real_registry", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const necromancy: Necromancy = createNecromancy({ client: stubClient(), projectsRoot: root });
    registerNecromancyTools(server, necromancy);
    const tools = registeredTools(server);

    // 1. outline: role-tagged, index-addressed entries covering the whole session.
    const outlineResult = await tools.necromancy_outline!.handler({ sessionId: SESSION_ID, cwd: CWD }, {});
    expect(outlineResult.isError).toBeFalsy();
    const outline = JSON.parse(outlineResult.content[0]!.text);
    expect(outline.total).toBe(5);
    expect(outline.entries.map((e: { role: string }) => e.role)).toEqual([
      "user",
      "thinking",
      "tool_use",
      "tool_result",
      "text",
    ]);
    expect(outline.entries[2].tool).toBe("Bash");

    // 2. search: find the turn discussing the race condition, get its index back.
    const searchResult = await tools.necromancy_search!.handler(
      { sessionId: SESSION_ID, cwd: CWD, query: "race condition" },
      {},
    );
    expect(searchResult.isError).toBeFalsy();
    const search = JSON.parse(searchResult.content[0]!.text);
    expect(search.truncated).toBe(false);
    expect(search.matches).toHaveLength(1);
    const hitIndex = search.matches[0].index;
    expect(hitIndex).toBe(4);

    // 3. read: pull that exact turn back verbatim by the index search returned.
    const readResult = await tools.necromancy_read!.handler({ sessionId: SESSION_ID, cwd: CWD, from: hitIndex }, {});
    expect(readResult.isError).toBeFalsy();
    const read = JSON.parse(readResult.content[0]!.text);
    expect(read.truncated).toBe(false);
    expect(read.entries).toEqual([{ index: 4, role: "text", text: "found it: a race condition on line 42" }]);
  });

  it("DW_2_5_necromancy_read_on_a_non_uuid_sessionId_via_the_registry_surfaces_isError_not_a_crash", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const necromancy: Necromancy = createNecromancy({ client: stubClient(), projectsRoot: root });
    registerNecromancyTools(server, necromancy);

    const result = await registeredTools(server).necromancy_read!.handler(
      { sessionId: "not-a-uuid", cwd: CWD, from: 0 },
      {},
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("not a UUID");
  });

  it("DW_2_5_necromancy_read_on_an_absent_sessionId_via_the_registry_surfaces_isError_not_a_crash", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const necromancy: Necromancy = createNecromancy({ client: stubClient(), projectsRoot: root });
    registerNecromancyTools(server, necromancy);

    const result = await registeredTools(server).necromancy_read!.handler(
      { sessionId: "22222222-2222-2222-2222-222222222222", cwd: CWD, from: 0 },
      {},
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("no session file");
  });
});
