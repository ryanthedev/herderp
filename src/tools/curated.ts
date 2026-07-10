// Curated MCP tools over HerdrClient - one-shot ergonomics for the herdr
// subcommands listed in the plan's Phase 2 scope: agent list/get/read/wait,
// workspace create/focus, pane run/close, session list. (workspaceList is a
// HerdrClient method used internally by Phase 3's necromancy core - it is
// deliberately not exposed as its own curated tool here, staying inside the
// plan's IN scope.)
//
// Every handler just calls the matching HerdrClient method and returns its
// typed result - registerTool (Phase 1) already handles the MCP response
// shape and turns a thrown HerdrError into an isError tool result.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTool } from "../registry.js";
import type { HerdrClient } from "../herdr/client.js";

const AGENT_WAIT_STATUS = z.enum(["idle", "working", "blocked", "unknown"]);
const AGENT_READ_SOURCE = z.enum(["visible", "recent", "recent-unwrapped"]);
const AGENT_READ_FORMAT = z.enum(["text", "ansi"]);

/** Registers the curated herdr tools on `server`, backed by `client`. */
export function registerCuratedTools(server: McpServer, client: HerdrClient): void {
  registerTool(server, {
    name: "herdr_agent_list",
    description: "Lists every agent herdr currently tracks across all panes.",
    inputSchema: {},
    handler: async () => ({ agents: await client.agentList() }),
  });

  registerTool(server, {
    name: "herdr_agent_get",
    description: "Gets one herdr agent by target (terminal id, unique agent name, or pane id).",
    inputSchema: { target: z.string() },
    handler: async ({ target }) => ({ ...(await client.agentGet(target)) }),
  });

  registerTool(server, {
    name: "herdr_agent_read",
    description: "Reads recent pane output for one herdr agent (visible/recent scrollback).",
    inputSchema: {
      target: z.string(),
      source: AGENT_READ_SOURCE.optional(),
      lines: z.number().int().positive().optional(),
      format: AGENT_READ_FORMAT.optional(),
      ansi: z.boolean().optional(),
    },
    handler: async ({ target, ...opts }) => ({ text: await client.agentRead(target, opts) }),
  });

  registerTool(server, {
    name: "herdr_agent_wait",
    description: "Waits (bounded) for a herdr agent to reach a given status; times out as a typed error.",
    inputSchema: {
      target: z.string(),
      status: AGENT_WAIT_STATUS,
      timeoutMs: z.number().int().positive().optional(),
    },
    handler: async ({ target, status, timeoutMs }) => ({ ...(await client.agentWait(target, { status, timeoutMs })) }),
  });

  registerTool(server, {
    name: "herdr_workspace_create",
    description: "Creates a new herdr workspace at a given cwd, optionally labeled and focused.",
    inputSchema: {
      cwd: z.string(),
      label: z.string().optional(),
      focus: z.boolean().optional(),
    },
    handler: async (opts) => ({ ...(await client.workspaceCreate(opts)) }),
  });

  registerTool(server, {
    name: "herdr_workspace_focus",
    description: "Focuses an existing herdr workspace by id.",
    inputSchema: { id: z.string() },
    handler: async ({ id }) => {
      await client.workspaceFocus(id);
      return { ok: true };
    },
  });

  registerTool(server, {
    name: "herdr_pane_run",
    description: "Runs a shell command in a herdr pane (types the command and submits it).",
    inputSchema: { paneId: z.string(), command: z.string() },
    handler: async ({ paneId, command }) => {
      await client.paneRun(paneId, command);
      return { ok: true };
    },
  });

  registerTool(server, {
    name: "herdr_pane_close",
    description: "Closes a herdr pane by id.",
    inputSchema: { paneId: z.string() },
    handler: async ({ paneId }) => {
      await client.paneClose(paneId);
      return { ok: true };
    },
  });

  registerTool(server, {
    name: "herdr_session_list",
    description: "Lists herdr's named persistent sessions (server instances), marking the default and which are running.",
    inputSchema: {},
    handler: async () => ({ sessions: await client.sessionList() }),
  });
}
