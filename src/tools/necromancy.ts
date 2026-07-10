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
import {
  DEFAULT_MAX_OUTLINE_ENTRIES,
  DEFAULT_MAX_READ_BYTES,
  DEFAULT_MAX_SEARCH_MATCHES,
  type TurnRole,
} from "../necromancy/reader.js";

// The five TurnRole values, spelled out because zod enums need string
// literals (not a TS type). `satisfies TurnRole[]` keeps this list in sync
// with reader.ts's TurnRole union at compile time.
const TURN_ROLES = ["user", "thinking", "text", "tool_use", "tool_result"] as const satisfies readonly TurnRole[];

// Ceilings for model-supplied limit/maxBytes/offset. core.ts's
// sessionOutline/sessionSearch/sessionRead do NOT clamp caller-supplied
// values down to their configured defaults (a caller value passes through
// unclamped - see Phase 1 review carry-over), so the tool layer must cap
// them here via zod `.max()`. Reusing reader.ts's own defaults as the
// ceiling keeps the tool-facing limit identical to the server's own intent.

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

  registerTool(server, {
    name: "necromancy_outline",
    description:
      `Lists a session's turns as one short line each (a stable 0-based "index", a role - ` +
      "user/thinking/text/tool_use/tool_result - the tool name for tool_use/tool_result, and a clipped preview), " +
      `paged by offset/limit (limit capped at ${DEFAULT_MAX_OUTLINE_ENTRIES}) and optionally narrowed to one role via ` +
      "filter (e.g. filter: tool_use for a tool-call ledger). Returns total and nextOffset for paging. " +
      "Every entry's index is directly addressable by necromancy_read - use outline or necromancy_search to find " +
      "indexes, then necromancy_read to see one in full.",
    inputSchema: {
      sessionId: z.string(),
      cwd: z.string(),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(DEFAULT_MAX_OUTLINE_ENTRIES).optional(),
      filter: z.enum(TURN_ROLES).optional(),
    },
    handler: async ({ sessionId, cwd, offset, limit, filter }) =>
      ({ ...(await necromancy.sessionOutline({ sessionId, cwd, offset, limit, filter })) }) as Record<string, unknown>,
  });

  registerTool(server, {
    name: "necromancy_search",
    description:
      "Case-insensitive lexical search (or, with regex:true, a regex pattern) over a session's turns. Each match " +
      `carries the turn's index, role, tool name (for tool_use/tool_result), and a bounded snippet with the match ` +
      `in context. Capped at limit (max ${DEFAULT_MAX_SEARCH_MATCHES}); truncated:true means more matched than were ` +
      "returned - narrow the query rather than assuming these are all the hits. Feed a match's index into " +
      "necromancy_read to see that turn in full.",
    inputSchema: {
      sessionId: z.string(),
      cwd: z.string(),
      query: z.string(),
      limit: z.number().int().min(1).max(DEFAULT_MAX_SEARCH_MATCHES).optional(),
      regex: z.boolean().optional(),
    },
    handler: async ({ sessionId, cwd, query, limit, regex }) =>
      ({ ...(await necromancy.sessionSearch({ sessionId, cwd, query, limit, regex })) }) as Record<string, unknown>,
  });

  registerTool(server, {
    name: "necromancy_read",
    description:
      "Returns the verbatim content of a session's turns in the index range [from, to] (to defaults to from - a " +
      "single turn). Get indexes from necromancy_outline or necromancy_search first; never guess one. Both the " +
      `entry span and the total response size are hard-capped (maxBytes, capped at ${DEFAULT_MAX_READ_BYTES} bytes); ` +
      "truncated:true means the cap cut the range short - page forward with a new from rather than assuming the " +
      "whole range came back.",
    inputSchema: {
      sessionId: z.string(),
      cwd: z.string(),
      from: z.number().int().min(0),
      to: z.number().int().min(0).optional(),
      maxBytes: z.number().int().min(1).max(DEFAULT_MAX_READ_BYTES).optional(),
    },
    handler: async ({ sessionId, cwd, from, to, maxBytes }) =>
      ({ ...(await necromancy.sessionRead({ sessionId, cwd, from, to, maxBytes })) }) as Record<string, unknown>,
  });
}
