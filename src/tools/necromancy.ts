// Necromancy MCP tools - thin registrations over the necromancy core
// (DW-3.6). All logic (slug rule, graveyard scan, validation) lives in
// src/necromancy/core.ts where it is unit-testable; each handler here is one
// method call. registerTool (Phase 1) supplies the MCP response shape and
// turns thrown NecromancyError/HerdrError into isError tool results.

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
import { DEFAULT_MAX_SPACES } from "../necromancy/core.js";

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

/**
 * Registers the necromancy tools on `server`, backed by `necromancy`:
 * find_spaces, list_sessions, outline, search, read.
 */
export function registerNecromancyTools(server: McpServer, necromancy: Necromancy): void {
  registerTool(server, {
    name: "necromancy_find_spaces",
    description:
      "Lists Claude Code project spaces from the on-disk session graveyard (~/.claude/projects), joined with live " +
      "herdr workspaces: cwd, label, workspaceId, session count, and last activity. Newest-active first and " +
      `capped (limit, max ${DEFAULT_MAX_SPACES}) - a machine can hold hundreds of spaces, so pass a query to narrow ` +
      "to the one you want (case-insensitive substring over cwd/label/workspaceId) rather than dumping them all. " +
      "Returns total and truncated: truncated:true means more matched than were returned - narrow the query. " +
      "If you already know the exact cwd (e.g. the current project), skip this and call necromancy_list_sessions directly.",
    inputSchema: {
      query: z.string().optional(),
      limit: z.number().int().min(1).max(DEFAULT_MAX_SPACES).optional(),
    },
    handler: async ({ query, limit }) =>
      ({ ...(await necromancy.findSpaces({ query, limit })) }) as Record<string, unknown>,
  });

  registerTool(server, {
    name: "necromancy_list_sessions",
    description:
      "Lists Claude Code sessions for one space (its cwd), newest first, with a one-line preview and message count " +
      "for each. Live sessions are marked and carry their herdr handle (`<workspace-label>:<tab-label>`, e.g. " +
      "upublish:1) so you can see which live agent each session is. Pass currentSessionId (the running session's " +
      "own id, from $CLAUDE_CODE_SESSION_ID) to flag `current:true` on the session you're in - never read it as a " +
      "target. Returns degraded:true when herdr was unreachable: the on-disk sessions still come back (live all " +
      "false, no handles) - say live status is unknown rather than implying nothing is running.",
    inputSchema: { space: z.string(), currentSessionId: z.string().optional() },
    handler: async ({ space, currentSessionId }) =>
      ({ ...(await necromancy.listSessions(space, { currentSessionId })) }) as Record<string, unknown>,
  });

  registerTool(server, {
    name: "necromancy_resolve",
    description:
      "Resolves a herdr agent handle like `upublish:1` (workspace label : tab label) to the exact live session it " +
      "addresses, in one shot - use this the moment a target looks like `<space>:<n>` rather than guessing from a " +
      "session list. Returns status:'resolved' with {sessionId, cwd, handle, matchedTabLabel, isCurrent} - feed " +
      "sessionId+cwd straight into necromancy_anchors/read. Other statuses are actionable data, not errors: " +
      "'ambiguous_workspace'/'ambiguous_pane' carry candidates to present; 'not_found' carries a reason " +
      "(workspace/tab/no_claude_agent/...) meaning fall through to necromancy_list_sessions and pick by on-disk " +
      "index instead. Pass workspaceId ($HERDR_WORKSPACE_ID) to resolve a label-less `:<tab>` against the current " +
      "space, and currentSessionId ($CLAUDE_CODE_SESSION_ID) so isCurrent flags the running session. A herdr " +
      "outage surfaces as a tool error (herdr must be running for this) - list_sessions still works without it.",
    inputSchema: {
      handle: z.string(),
      workspaceId: z.string().optional(),
      currentSessionId: z.string().optional(),
    },
    handler: async ({ handle, workspaceId, currentSessionId }) =>
      ({ ...(await necromancy.resolveHandle({ handle, workspaceId, currentSessionId })) }) as Record<string, unknown>,
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

  registerTool(server, {
    name: "necromancy_anchors",
    description:
      "Deterministically extracts a session's 'always grab' anchor set - the load-bearing facts a catch-up must " +
      "never miss: ask (first user turn), lastState (where it left off), commits, prs, versions, files touched, " +
      "errors, tests (result lines), and decisions (user directives). Pure regex over the transcript, no model call. " +
      "Grab these first and ground a summary on them rather than relying on a skim. Each list is deduped and capped.",
    inputSchema: {
      sessionId: z.string(),
      cwd: z.string(),
    },
    handler: async ({ sessionId, cwd }) =>
      ({ ...(await necromancy.sessionAnchors({ sessionId, cwd })) }) as Record<string, unknown>,
  });
}
