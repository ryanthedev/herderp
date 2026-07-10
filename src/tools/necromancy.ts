// Necromancy MCP tools - thin registrations over the necromancy core
// (DW-3.6). All logic (slug rule, graveyard scan, validation, revival
// orchestration) lives in src/necromancy/core.ts where it is unit-testable;
// each handler here is one method call. registerTool (Phase 1) supplies the
// MCP response shape and turns thrown NecromancyError/HerdrError into
// isError tool results.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTool } from "../registry.js";
import type { Necromancy } from "../necromancy/core.js";

/** Registers the three necromancy tools on `server`, backed by `necromancy`. */
export function registerNecromancyTools(server: McpServer, necromancy: Necromancy): void {
  registerTool(server, {
    name: "necromancy_find_spaces",
    description:
      "Lists Claude Code project spaces from the on-disk session graveyard (~/.claude/projects), joined with live herdr workspaces: cwd, label, workspaceId, session count, and last activity.",
    inputSchema: {},
    handler: async () => ({ spaces: await necromancy.findSpaces() }),
  });

  registerTool(server, {
    name: "necromancy_list_sessions",
    description:
      "Lists Claude Code sessions for one space (its cwd), newest first, marking which are live in herdr, with a one-line preview and message count for each.",
    inputSchema: { space: z.string() },
    handler: async ({ space }) => ({ sessions: await necromancy.listSessions(space) }),
  });

  registerTool(server, {
    name: "necromancy_revive",
    description:
      "Revives a dead Claude Code session: validates the session id (strict UUID), creates a herdr workspace at the cwd, runs `claude --resume` in its root pane, and waits (bounded) for herdr to detect the agent. Returns {workspaceId, paneId, sessionId, detected}.",
    inputSchema: { sessionId: z.string(), cwd: z.string() },
    handler: async ({ sessionId, cwd }) => ({ ...(await necromancy.revive({ sessionId, cwd })) }),
  });
}
