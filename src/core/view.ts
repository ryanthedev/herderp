// view.ts: herdr-core + the Herdr app, seen through herdr's model.
//
// Necromancy's live join (which sessions are live, which handle reaches
// them) was written against herdr's workspaces > tabs > panes. The Herdr app
// has the same shape - spaces > tabs > panes showing terminals - so this
// adapter answers the four list calls necromancy makes, in herdr's types:
//   workspace = space (cwd: its first terminal's live folder, as the app
//               itself names a space; else the folder it was made in)
//   tab       = tab (number: its 1-based position in the space)
//   pane      = pane, or a pane-less sub-agent's terminal address
//   agent     = a terminal running Claude Code, with its session from
//               ~/.claude/sessions/<pid>.json
// Failures throw CoreError, which necromancy treats like an unreachable herdr.

import type { HerdrClient } from "../herdr/client.js";
import type { Agent, AgentStatus, Pane, Tab, Workspace } from "../herdr/types.js";
import type { CoreClient } from "./client.js";
import { isClaudeTerminal, type SessionLookup } from "./sessions.js";
import type { AppSpace, CoreTerminal } from "./types.js";

/** The slice of HerdrClient necromancy reads live state through. */
export type LiveView = Pick<HerdrClient, "agentList" | "workspaceList" | "tabList" | "paneList"> & {
  /** Which engine it reads, for results that span several. Unset: herdr. */
  engine?: string;
};

function toAgentStatus(terminal: CoreTerminal | undefined): AgentStatus {
  const status = terminal?.status;
  return status === "idle" || status === "working" || status === "blocked" || status === "done" ? status : "unknown";
}

export function createCoreView(core: CoreClient, sessions: SessionLookup): LiveView {
  /** One consistent snapshot: the window's layout plus every terminal's facts. */
  async function snapshot(): Promise<{ spaces: AppSpace[]; terminals: Map<string, CoreTerminal> }> {
    const [spaces, listing] = await Promise.all([core.appSpaces(), core.terminalList()]);
    return { spaces, terminals: new Map(listing.terminals.map((t) => [t.address, t])) };
  }

  async function sessionOf(terminal: CoreTerminal | undefined): Promise<string> {
    if (!terminal || !isClaudeTerminal(terminal)) return "";
    return (await sessions(terminal)) ?? "";
  }

  function spaceCwd(space: AppSpace, terminals: Map<string, CoreTerminal>): string {
    for (const tab of space.tabs) {
      for (const ref of tab.terminals) {
        const cwd = terminals.get(qualified(space, ref.terminal))?.cwd;
        if (cwd) return cwd;
      }
    }
    return space.folder ?? "";
  }

  return {
    engine: "core",
    async workspaceList(): Promise<Workspace[]> {
      const { spaces, terminals } = await snapshot();
      return spaces.map((space) => ({
        id: space.id,
        label: space.name || null,
        cwd: spaceCwd(space, terminals),
        tabCount: space.tabs.length,
        paneCount: space.tabs.reduce((n, tab) => n + tab.terminals.length, 0),
      }));
    },
    async tabList(workspaceId?: string): Promise<Tab[]> {
      const spaces = await core.appSpaces();
      return spaces
        .filter((space) => workspaceId === undefined || space.id === workspaceId)
        .flatMap((space) =>
          space.tabs.map((tab, index) => ({
            id: tab.id,
            workspaceId: space.id,
            label: tab.name || null,
            number: index + 1,
            focused: tab.active,
          })),
        );
    },
    async paneList(workspaceId?: string): Promise<Pane[]> {
      const { spaces, terminals } = await snapshot();
      const panes: Pane[] = [];
      for (const space of spaces) {
        if (workspaceId !== undefined && space.id !== workspaceId) continue;
        for (const tab of space.tabs) {
          for (const ref of tab.terminals) {
            const terminal = terminals.get(qualified(space, ref.terminal));
            const sessionId = await sessionOf(terminal);
            panes.push({
              id: ref.pane,
              workspaceId: space.id,
              tabId: tab.id,
              agent: terminal && isClaudeTerminal(terminal) ? "claude" : (terminal?.app ?? ""),
              sessionId,
              cwd: terminal?.cwd ?? "",
              status: toAgentStatus(terminal),
            });
          }
        }
      }
      return panes;
    },
    async agentList(): Promise<Agent[]> {
      const { spaces, terminals } = await snapshot();
      const paneOf = new Map<string, { pane: string; space: string; tab: string }>();
      for (const space of spaces) {
        for (const tab of space.tabs) {
          for (const ref of tab.terminals) paneOf.set(qualified(space, ref.terminal), { pane: ref.pane, space: space.id, tab: tab.id });
        }
      }
      const agents: Agent[] = [];
      for (const terminal of terminals.values()) {
        if (terminal.state !== "live" || !isClaudeTerminal(terminal)) continue;
        const place = paneOf.get(terminal.address);
        agents.push({
          agent: "claude",
          sessionId: await sessionOf(terminal),
          status: toAgentStatus(terminal),
          cwd: terminal.cwd,
          workspaceId: place?.space ?? terminal.spaceId ?? "",
          tabId: place?.tab ?? terminal.tabId ?? "",
          paneId: place?.pane ?? terminal.address,
        });
      }
      return agents;
    },
  };
}

/** A space's terminal refs are bare (`t7`) - qualify them for a remote space. */
function qualified(space: AppSpace, terminal: string): string {
  if (space.machine === null || terminal.includes("/")) return terminal;
  return `${space.machine}/${terminal}`;
}
