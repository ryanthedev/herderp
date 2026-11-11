// herdr_team: agent teams in the Herdr app as one resource. A team is a
// space; its members are agent sessions in tabs, tied into a tree by the
// `reports-to` label (src/team/roster.ts states the convention). Each action
// here replaces the 3-6 hand-made `hc` and herdr_* calls a team lead made
// before: start + label + find the tab + rename it, and so on.
//
// The handler is a thin dispatch into src/team/core.ts: it names missing
// fields, makes one call, and adds the `hint`.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTool } from "../registry.js";
import type { Team } from "../team/core.js";
import { DEFAULT_STALL_MS } from "../team/roster.js";

const TOOL = "herdr_team";

/** Ceilings applied at the tool boundary; the core takes what it is given. */
export const MAX_TEAM_TARGETS = 64;
export const MAX_PASS_ENV = 16;

const ACTIONS = ["start", "roster", "watch", "recycle", "cleanup"] as const;

function need<T>(value: T | undefined, field: string, action: string): T {
  if (value === undefined || value === "") throw new Error(`${TOOL}{action:"${action}"} requires "${field}"`);
  return value;
}

const DESCRIPTION =
  "Run a team of agent sessions in the Herdr app: a space is a team, each member is a session in its own named tab, and the " +
  "`reports-to` label ties them into a tree. Herdr app (herdr-core) only. Pick with `action`:\n" +
  "- start: start a member in one call - launch it, label it, find its tab and rename it (kind, and prompt or brief; role and/or job, " +
  "or tabLabel). brief is a file path and becomes 'Read <brief> and do it.'. Defaults: space = yours, reportsTo = you ('none' = top of " +
  "the tree), cwd = yours, tabLabel = '<role> <job>', and for claude the same --settings and --plugin-dir list you were started with " +
  "(override with settings / pluginDirs). argv adds arguments before the prompt; labels adds extra labels; passEnv names environment " +
  "variables to copy from your session into the new one (values are never shown). Returns target (terminal id) and tabId.\n" +
  "- roster: a space's team as a tree by reports-to (optional space, stallMs). Each member: role, job, tab label, status, contextPct " +
  "(pane footer), lastMessage. `attention` lists who needs a look, worst first: permission (waiting on a permission prompt, with the " +
  "prompt text), blocked, question (stopped with a question), draft (text typed in its composer while it works, unsent), stalled, context (60% or more). Each member's `composer` is the text in its composer; once it has stopped that may be Claude Code's own greyed suggestion, so it is not flagged.\n" +
  "- watch: one watch over a member and everyone under it (target; optional stallMs, once, json, verbose). Returns a command for the " +
  "Monitor tool. A snapshot: members started later are not covered until you re-arm it.\n" +
  "- recycle: hand a member off to a fresh successor (handoff = the hand-off file, which must exist; optional target, default you; " +
  "optional prompt, passEnv). The successor gets the same labels, launch flags, folder, tab label and reports-to; the old one's reports " +
  "are re-pointed, and it is labelled retired and its tab renamed 'retired ...'. It is never killed here.\n" +
  "- cleanup: close the tab and end the terminal of members that are retired or whose program has ended (optional space, targets, " +
  "dryRun, force). Only team members of that space; never you, never one that still has reports, never by status alone.\n" +
  "Labels: role (orchestrator = leader), job, reports-to=<terminal id>, retired=<successor>. Teams started by hand with " +
  "<project>.reports-to are read too.";

export function registerTeamTools(server: McpServer, team: Team): void {
  registerTool(server, {
    name: TOOL,
    description: DESCRIPTION,
    inputSchema: {
      action: z.enum(ACTIONS),
      space: z.string().optional(),
      target: z.string().optional(),
      targets: z.array(z.string()).max(MAX_TEAM_TARGETS).optional(),
      kind: z.string().optional(),
      prompt: z.string().optional(),
      brief: z.string().optional(),
      role: z.string().optional(),
      job: z.string().optional(),
      tabLabel: z.string().optional(),
      reportsTo: z.string().optional(),
      labels: z.record(z.string()).optional(),
      settings: z.string().optional(),
      pluginDirs: z.array(z.string()).optional(),
      argv: z.array(z.string()).optional(),
      cwd: z.string().optional(),
      passEnv: z.array(z.string()).max(MAX_PASS_ENV).optional(),
      handoff: z.string().optional(),
      stallMs: z.number().int().positive().optional(),
      once: z.boolean().optional(),
      json: z.boolean().optional(),
      verbose: z.boolean().optional(),
      dryRun: z.boolean().optional(),
      force: z.boolean().optional(),
    },
    handler: async (args) => {
      switch (args.action) {
        case "start": {
          const started = await team.start({ ...args, kind: need(args.kind, "kind", "start") });
          const { warnings, ...rest } = started;
          return {
            ok: true,
            ...rest,
            ...(warnings.length > 0 ? { warnings } : {}),
            hint:
              (started.tabId === null
                ? `it is running, but its tab was not found - herdr_tab{action:'list',workspaceId:"${started.spaceId}"} then herdr_tab{action:'rename'}; `
                : "") +
              (started.envMissing.length > 0 ? `not set in your session, so not passed: ${started.envMissing.join(", ")}; ` : "") +
              `herdr_team{action:'watch',target:"${started.target}"} to hear when it stops, herdr_team{action:'roster'} to see the team`,
          };
        }
        case "roster": {
          const roster = await team.roster({ space: args.space, stallMs: args.stallMs });
          return {
            ...roster,
            hint:
              roster.attention.length > 0
                ? `${roster.attention.length} need a look (attention, worst first): answer a permission prompt with herdr_agent{action:'send_keys'}, a question with herdr_agent{action:'prompt'}, context with herdr_team{action:'recycle'}. question is a heuristic - herdr_agent{action:'read'} to confirm`
                : `nobody needs a look; stalled means no transcript movement for ${Math.round((args.stallMs ?? DEFAULT_STALL_MS) / 60_000)} min. herdr_team{action:'watch',target} to be told when a subtree stops`,
          };
        }
        case "watch": {
          const plan = await team.watch({
            target: need(args.target, "target", "watch"),
            stallMs: args.stallMs,
            once: args.once,
            json: args.json,
            verbose: args.verbose,
          });
          return {
            ...plan,
            hint:
              "Pass command, description and timeout_ms to the Monitor tool; each line it prints is one notification (a member stopping, " +
              "stalling or going away). It covers the members listed in targets as of now - call this again after starting new ones. " +
              "Monitor ends the watch after 30 minutes; re-arm if you still need it.",
          };
        }
        case "recycle": {
          const result = await team.recycle({
            target: args.target,
            handoff: need(args.handoff, "handoff", "recycle"),
            prompt: args.prompt,
            passEnv: args.passEnv,
          });
          const { warnings, self, ...rest } = result;
          return {
            ok: true,
            ...rest,
            ...(warnings.length > 0 ? { warnings } : {}),
            hint: self
              ? `${result.successor.target} has taken over from you: finish your turn and stop. Whoever you reported to closes you with herdr_team{action:'cleanup'}`
              : `${result.successor.target} has taken over; herdr_team{action:'cleanup',targets:["${result.retired}"]} closes the old one once its hand-off is committed`,
          };
        }
        case "cleanup": {
          const result = await team.cleanup({ space: args.space, targets: args.targets, dryRun: args.dryRun, force: args.force });
          const stuck = result.closed.filter((row) => row.gone === false).map((row) => row.target);
          return {
            ok: true,
            ...result,
            hint: result.dryRun
              ? "nothing was changed; call again without dryRun to close these"
              : stuck.length > 0
                ? `still listed after closing: ${stuck.join(", ")} - herdr_agent{action:'get'} to see what is left`
                : result.closed.length === 0
                  ? "nothing to close: no member of this space is retired or ended (name targets to close one that is merely done)"
                  : "closed; herdr_team{action:'roster'} shows who is left",
          };
        }
      }
    },
  });
}
