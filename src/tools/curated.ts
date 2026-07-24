// Curated MCP tools over HerdrClient - resource-oriented, not one tool per
// CLI subcommand.
//
// herdr's CLI exposes ~35 subcommands across agent/pane/tab/workspace/
// worktree/session. Registering each as its own MCP tool would put ~35 names
// and schemas in every consuming session's context and make tool selection
// noticeably harder (many near-identical names). Instead each RESOURCE gets
// one tool with an `action` discriminator, so full CLI coverage costs six
// tools instead of thirty-five.
//
// The tradeoff that buys: a call is no longer self-describing from its name
// alone, so two things carry that weight instead.
//   1. Descriptions spell out, per action, which fields are required - the
//      schema cannot, because every field must be optional at the type level
//      (each is required for only some actions).
//   2. Validation is explicit and NAMES the valid alternative rather than
//      failing generically, and successes carry a `hint` pointing at the
//      natural next call. Fewer tools means each has to teach more.
//
// Deliberately NOT exposed: `pane report-agent`, `pane report-agent-session`,
// `pane release-agent`, `pane report-metadata` (herdr's own integration
// plumbing - an agent should never call them) and `agent attach --takeover`
// (seizes a live terminal interactively; wrong shape for a tool call).
//
// Every handler is a thin dispatch to the matching HerdrClient method;
// registerTool (Phase 1) supplies the MCP response shape and turns a thrown
// HerdrError into an isError tool result.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTool } from "../registry.js";
import type { HerdrClient } from "../herdr/client.js";

const AGENT_WAIT_STATUS = z.enum(["idle", "working", "blocked", "unknown"]);
const AGENT_READ_SOURCE = z.enum(["visible", "recent", "recent-unwrapped"]);
const AGENT_READ_FORMAT = z.enum(["text", "ansi"]);
const DIRECTION = z.enum(["left", "right", "up", "down"]);
const SPLIT_DIRECTION = z.enum(["right", "down"]);

/**
 * Throws a message naming the tool, the action, and the missing field, so a
 * caller that guessed the contract is told exactly what to send instead of
 * getting herdr's bare usage text back.
 */
function need<T>(value: T | undefined, field: string, tool: string, action: string): T {
  if (value === undefined || value === "") {
    throw new Error(`${tool}{action:"${action}"} requires "${field}"`);
  }
  return value;
}

/**
 * Resolves the rename argument for the two resources whose herdr command
 * accepts `--clear` (agent and pane). `tab rename`/`workspace rename` have no
 * --clear, so those tools expose no `clear` field at all and just require a
 * label - see their handlers.
 */
function renameTarget(opts: { name?: string; clear?: boolean }, tool: string): string | null {
  if (opts.clear) {
    if (opts.name !== undefined) {
      throw new Error(`${tool}{action:"rename"} takes either "name" or "clear", not both`);
    }
    return null;
  }
  return need(opts.name, "name", tool, "rename");
}

/** Success envelope. `hint` names the natural follow-up call - with six tools
 * covering 35 commands, the result has to point the way forward. */
function ok(hint: string, data?: Record<string, unknown>): Record<string, unknown> {
  return { ok: true, ...data, hint };
}

/** Registers the curated herdr tools on `server`, backed by `client`. */
export function registerCuratedTools(server: McpServer, client: HerdrClient): void {
  registerTool(server, {
    name: "herdr_agent",
    description:
      "Inspect and control the coding agents running in herdr panes. One tool, many actions - pick with `action`:\n" +
      "- list: every agent (needs nothing else). get: one agent's status/cwd/ids (target).\n" +
      "- read: scrollback text (target; optional source/lines/format/ansi).\n" +
      "- send: type literal text into the agent, NO trailing Enter (target, text). Use herdr_pane{action:'run'} when you want command text plus Enter.\n" +
      "- focus: bring the agent's pane to the front (target).\n" +
      "- rename: give an agent a stable name, or clear:true to drop a custom one (target, then name or clear).\n" +
      "- start: launch a new agent (name, argv; optional cwd/workspaceId/tabId/split/env/focus).\n" +
      "- wait: block until the agent reaches a status (target, status; optional timeoutMs). status accepts idle/working/blocked/unknown - NOT 'done'.\n" +
      "- explain: herdr's own diagnosis of how it detected this agent's state (target) - reach for it when a reported status looks wrong.\n" +
      "`target` accepts a terminal id, a unique agent name, a detected agent label, or a legacy pane id.",
    inputSchema: {
      action: z.enum(["list", "get", "read", "send", "focus", "rename", "start", "wait", "explain"]),
      target: z.string().optional(),
      text: z.string().optional(),
      name: z.string().optional(),
      clear: z.boolean().optional(),
      source: AGENT_READ_SOURCE.optional(),
      lines: z.number().int().positive().optional(),
      format: AGENT_READ_FORMAT.optional(),
      ansi: z.boolean().optional(),
      status: AGENT_WAIT_STATUS.optional(),
      timeoutMs: z.number().int().positive().optional(),
      argv: z.array(z.string()).optional(),
      cwd: z.string().optional(),
      workspaceId: z.string().optional(),
      tabId: z.string().optional(),
      split: SPLIT_DIRECTION.optional(),
      env: z.array(z.string()).optional(),
      focus: z.boolean().optional(),
    },
    handler: async (args) => {
      const tool = "herdr_agent";
      switch (args.action) {
        case "list":
          return {
            agents: await client.agentList(),
            hint: "address any of these with target=<agent name or paneId>, e.g. herdr_agent{action:'read',target}",
          };
        case "get":
          return { agent: await client.agentGet(need(args.target, "target", tool, "get")) };
        case "read":
          return {
            text: await client.agentRead(need(args.target, "target", tool, "read"), {
              source: args.source,
              lines: args.lines,
              format: args.format,
              ansi: args.ansi,
            }),
          };
        case "send":
          await client.agentSend(need(args.target, "target", tool, "send"), need(args.text, "text", tool, "send"));
          return ok("text typed (no Enter sent); herdr_agent{action:'read'} to see the result");
        case "focus":
          await client.agentFocus(need(args.target, "target", tool, "focus"));
          return ok("agent focused");
        case "rename": {
          const target = need(args.target, "target", tool, "rename");
          const name = renameTarget(args, tool);
          await client.agentRename(target, name);
          return ok(
            name === null
              ? "custom name cleared; herdr_agent{action:'list'} to see the fallback label"
              : `renamed; address it as target:"${name}" from now on`,
          );
        }
        case "start": {
          const name = need(args.name, "name", tool, "start");
          if (args.argv === undefined || args.argv.length === 0) {
            throw new Error(`${tool}{action:"start"} requires a non-empty "argv" (the agent's own command line)`);
          }
          await client.agentStart({
            name,
            argv: args.argv,
            cwd: args.cwd,
            workspaceId: args.workspaceId,
            tabId: args.tabId,
            split: args.split,
            env: args.env,
            focus: args.focus,
          });
          return ok(`started; herdr_agent{action:'get',target:"${name}"} to confirm it came up`);
        }
        case "wait":
          return {
            agent: await client.agentWait(need(args.target, "target", tool, "wait"), {
              status: need(args.status, "status", tool, "wait"),
              timeoutMs: args.timeoutMs,
            }),
            hint: "status reached; herdr_agent{action:'read'} to see what it produced",
          };
        case "explain":
          return { explain: await client.agentExplain(need(args.target, "target", tool, "explain")) };
      }
    },
  });

  registerTool(server, {
    name: "herdr_pane",
    description:
      "Pane layout and command execution. Actions:\n" +
      "- list: all panes, or one workspace's (optional workspaceId). get: one pane (paneId).\n" +
      "- run: type a command into a pane WITH Enter (paneId, command). This is the one that actually executes - herdr_agent{action:'send'} does not press Enter.\n" +
      "- close: close a pane (paneId). rename: label a pane, or clear:true (paneId, then name or clear).\n" +
      "- focus: herdr moves focus DIRECTIONALLY and cannot focus a pane by id - pass direction (left/right/up/down), optionally paneId to anchor the move (defaults to the current pane). To surface a specific agent use herdr_agent{action:'focus'} instead.\n" +
      "- split: split a pane (splitDirection right/down; optional paneId/ratio/cwd/env/focus).\n" +
      "- swap: either an explicit pair (sourcePaneId + targetPaneId) or a directional swap (direction, optional paneId) - never both.\n" +
      "- move: relocate a pane; set destination to 'tab' (needs tabId + splitDirection), 'new-tab' (optional workspaceId/label), or 'new-workspace' (optional label/tabLabel).",
    inputSchema: {
      action: z.enum(["list", "get", "run", "close", "rename", "focus", "split", "swap", "move"]),
      paneId: z.string().optional(),
      workspaceId: z.string().optional(),
      command: z.string().optional(),
      name: z.string().optional(),
      clear: z.boolean().optional(),
      direction: DIRECTION.optional(),
      splitDirection: SPLIT_DIRECTION.optional(),
      ratio: z.number().positive().optional(),
      cwd: z.string().optional(),
      env: z.array(z.string()).optional(),
      focus: z.boolean().optional(),
      sourcePaneId: z.string().optional(),
      targetPaneId: z.string().optional(),
      destination: z.enum(["tab", "new-tab", "new-workspace"]).optional(),
      tabId: z.string().optional(),
      label: z.string().optional(),
      tabLabel: z.string().optional(),
    },
    handler: async (args) => {
      const tool = "herdr_pane";
      switch (args.action) {
        case "list":
          return {
            panes: await client.paneList(args.workspaceId),
            hint: "a pane with agent:'' is a plain shell, not an agent",
          };
        case "get":
          return { pane: await client.paneGet(need(args.paneId, "paneId", tool, "get")) };
        case "run":
          await client.paneRun(need(args.paneId, "paneId", tool, "run"), need(args.command, "command", tool, "run"));
          return ok("command typed and entered; herdr_agent{action:'read'} to see output");
        case "close":
          await client.paneClose(need(args.paneId, "paneId", tool, "close"));
          return ok("pane closed");
        case "rename": {
          const paneId = need(args.paneId, "paneId", tool, "rename");
          const name = renameTarget(args, tool);
          await client.paneRename(paneId, name);
          return ok(name === null ? "pane label cleared" : "pane renamed");
        }
        case "focus":
          await client.paneFocusDirection(need(args.direction, "direction", tool, "focus"), args.paneId);
          return ok("focus moved");
        case "split":
          await client.paneSplit({
            direction: need(args.splitDirection, "splitDirection", tool, "split"),
            paneId: args.paneId,
            ratio: args.ratio,
            cwd: args.cwd,
            env: args.env,
            focus: args.focus,
          });
          return ok("pane split; herdr_pane{action:'list'} to get the new pane's id");
        case "swap":
          await client.paneSwap({
            sourcePaneId: args.sourcePaneId,
            targetPaneId: args.targetPaneId,
            direction: args.direction,
            paneId: args.paneId,
          });
          return ok("panes swapped");
        case "move":
          await client.paneMove({
            paneId: need(args.paneId, "paneId", tool, "move"),
            destination: need(args.destination, "destination", tool, "move"),
            tabId: args.tabId,
            workspaceId: args.workspaceId,
            split: args.splitDirection,
            targetPaneId: args.targetPaneId,
            ratio: args.ratio,
            label: args.label,
            tabLabel: args.tabLabel,
            focus: args.focus,
          });
          return ok("pane moved; herdr_pane{action:'list'} to see the new layout");
      }
    },
  });

  registerTool(server, {
    name: "herdr_tab",
    description:
      "Tabs within a workspace. Actions: list (optional workspaceId), get (tabId), create (optional " +
      "workspaceId/cwd/label/focus), rename (tabId, label - no clear, herdr's tab rename has no --clear), " +
      "focus (tabId), close (tabId). A tab's `label` is what the user types after the colon in a " +
      "`<workspace>:<tab>` handle, so renaming a tab changes how necromancy_resolve addresses it. " +
      "Note `number` is a GLOBAL counter across all workspaces, not a per-workspace index - do not treat it as one.",
    inputSchema: {
      action: z.enum(["list", "get", "create", "rename", "focus", "close"]),
      tabId: z.string().optional(),
      workspaceId: z.string().optional(),
      cwd: z.string().optional(),
      label: z.string().optional(),
      focus: z.boolean().optional(),
    },
    handler: async (args) => {
      const tool = "herdr_tab";
      switch (args.action) {
        case "list":
          return { tabs: await client.tabList(args.workspaceId) };
        case "get":
          return { tab: await client.tabGet(need(args.tabId, "tabId", tool, "get")) };
        case "create": {
          const tab = await client.tabCreate({
            workspaceId: args.workspaceId,
            cwd: args.cwd,
            label: args.label,
            focus: args.focus,
          });
          // A null tab means herdr's create envelope carried no tab object -
          // the tab was still created (a failure would have exited nonzero
          // and thrown), the id just has to be looked up.
          return ok(tab === null ? "tab created; herdr_tab{action:'list'} to get its id" : "tab created", { tab });
        }
        case "rename":
          await client.tabRename(
            need(args.tabId, "tabId", tool, "rename"),
            need(args.label, "label", tool, "rename"),
          );
          return ok("tab renamed; this changes the `<workspace>:<tab>` handle it answers to");
        case "focus":
          await client.tabFocus(need(args.tabId, "tabId", tool, "focus"));
          return ok("tab focused");
        case "close":
          await client.tabClose(need(args.tabId, "tabId", tool, "close"));
          return ok("tab closed");
      }
    },
  });

  registerTool(server, {
    name: "herdr_workspace",
    description:
      "Workspaces (the top-level container, one per project cwd in normal use). Actions: list, get " +
      "(workspaceId), create (cwd; optional label/focus), rename (workspaceId, label - no clear), focus " +
      "(workspaceId), close (workspaceId). create returns the new workspace plus its root pane id, which is " +
      "what you feed to herdr_pane{action:'run'} to start something in it. Note herdr stores no workspace " +
      "cwd - it is inferred from the workspace's first pane.",
    inputSchema: {
      action: z.enum(["list", "get", "create", "rename", "focus", "close"]),
      workspaceId: z.string().optional(),
      cwd: z.string().optional(),
      label: z.string().optional(),
      focus: z.boolean().optional(),
    },
    handler: async (args) => {
      const tool = "herdr_workspace";
      switch (args.action) {
        case "list":
          return { workspaces: await client.workspaceList() };
        case "get":
          return { workspace: await client.workspaceGet(need(args.workspaceId, "workspaceId", tool, "get")) };
        case "create": {
          const workspace = await client.workspaceCreate({
            cwd: need(args.cwd, "cwd", tool, "create"),
            label: args.label,
            focus: args.focus,
          });
          return {
            workspace,
            hint: `run something in it with herdr_pane{action:'run',paneId:"${workspace.rootPaneId}",command:"..."}`,
          };
        }
        case "rename":
          await client.workspaceRename(
            need(args.workspaceId, "workspaceId", tool, "rename"),
            need(args.label, "label", tool, "rename"),
          );
          return ok("workspace renamed; its label is the `<workspace>` half of a herdr handle");
        case "focus":
          await client.workspaceFocus(need(args.workspaceId, "workspaceId", tool, "focus"));
          return ok("workspace focused");
        case "close":
          await client.workspaceClose(need(args.workspaceId, "workspaceId", tool, "close"));
          return ok("workspace closed");
      }
    },
  });

  registerTool(server, {
    name: "herdr_worktree",
    description:
      "Git worktrees, as herdr manages them. Actions: list, create (optional branch/base/path/label/focus), " +
      "open (path or branch), remove (workspaceId; optional force). " +
      "IMPORTANT: scope every call with workspaceId or cwd. A bare call resolves against herdr's currently " +
      "FOCUSED workspace in the UI - NOT the calling agent's own workspace or $HERDR_WORKSPACE_ID (verified " +
      "live) - so an unscoped call can silently answer about a different repo than the one you are working in.",
    inputSchema: {
      action: z.enum(["list", "create", "open", "remove"]),
      workspaceId: z.string().optional(),
      cwd: z.string().optional(),
      branch: z.string().optional(),
      base: z.string().optional(),
      path: z.string().optional(),
      label: z.string().optional(),
      focus: z.boolean().optional(),
      force: z.boolean().optional(),
    },
    handler: async (args) => {
      const tool = "herdr_worktree";
      const scope = { workspaceId: args.workspaceId, cwd: args.cwd };
      const unscoped = args.workspaceId === undefined && args.cwd === undefined;
      switch (args.action) {
        case "list":
          return {
            worktrees: await client.worktreeList(scope),
            hint: unscoped
              ? "unscoped: this listed the FOCUSED workspace's repo - pass cwd or workspaceId to be sure which repo you got"
              : "openWorkspaceId is set only on a worktree already open in a workspace",
          };
        case "create":
          await client.worktreeCreate({
            ...scope,
            branch: args.branch,
            base: args.base,
            path: args.path,
            label: args.label,
            focus: args.focus,
          });
          return ok("worktree created; herdr_worktree{action:'list'} to confirm and get its path");
        case "open":
          await client.worktreeOpen({
            ...scope,
            path: args.path,
            branch: args.branch,
            label: args.label,
            focus: args.focus,
          });
          return ok("worktree opened in a workspace; herdr_workspace{action:'list'} to find it");
        case "remove":
          await client.worktreeRemove(need(args.workspaceId, "workspaceId", tool, "remove"), args.force);
          return ok("worktree removed");
      }
    },
  });

  // Left as a plain single-purpose tool: `session attach` is interactive
  // (deliberately unexposed), so list is the only action - an `action` param
  // with exactly one legal value would be pure ceremony.
  registerTool(server, {
    name: "herdr_session_list",
    description:
      "Lists herdr's named persistent server sessions (the layer that owns workspaces), marking the default " +
      "and which are running. This is herdr's OWN session concept - not Claude Code agent sessions. For " +
      "those, use the necromancy_* tools.",
    inputSchema: {},
    handler: async () => ({ sessions: await client.sessionList() }),
  });
}
