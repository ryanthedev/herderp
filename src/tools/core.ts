// core.ts: the herdr-core / Herdr app side of each curated tool. curated.ts
// routes a call here when its target, ids, `engine`, or the caller's home
// engine say "core"; this file maps the tool's action onto `hc` (terminals,
// agents) or `herdr-app` (spaces, tabs, panes) through CoreClient.
//
// Actions with no core equivalent fail with `[unsupported_on_core]` and say
// what to use instead, rather than doing something close.

import type { CoreClient } from "../core/client.js";
import type { SessionLookup } from "../core/sessions.js";
import { CoreError, type AppSpace, type CoreTerminal } from "../core/types.js";


export function unsupported(tool: string, action: string, instead: string): CoreError {
  return new CoreError("unsupported_on_core", `${tool}{action:"${action}"} has no Herdr app (core) equivalent - ${instead}`);
}

/** A core agent as every herdr_agent result shows it. */
export interface CoreAgentRow {
  engine: "core";
  /** What to pass back as `target`: the terminal address. */
  target: string;
  name: string | null;
  agent: string;
  status: string | null;
  blockedKind: string | null;
  message: string;
  title: string;
  turn: number;
  cwd: string;
  spaceId: string | null;
  tabId: string | null;
  where: string | null;
  parent: string | null;
  machine: string | null;
  /** The Claude Code session running in it; null when it isn't Claude, or is remote. */
  sessionId: string | null;
}

export async function coreAgentRow(terminal: CoreTerminal, sessions: SessionLookup): Promise<CoreAgentRow> {
  return {
    engine: "core",
    target: terminal.address,
    name: terminal.name,
    agent: terminal.app || (terminal.foreground?.argv[0] ?? ""),
    status: terminal.status,
    blockedKind: terminal.blockedKind,
    message: terminal.message,
    title: terminal.title,
    turn: terminal.turn,
    cwd: terminal.cwd,
    spaceId: terminal.spaceId,
    tabId: terminal.tabId,
    where: terminal.where,
    parent: terminal.parent,
    machine: terminal.machine,
    sessionId: await sessions(terminal),
  };
}

/** Terminals on `host` only (null/"local": this machine), or all when host is undefined. */
export function onHost<T extends { machine: string | null }>(rows: T[], host: string | undefined): T[] {
  if (host === undefined || host === "") return rows;
  const machine = host === "local" ? null : host;
  return rows.filter((row) => row.machine === machine);
}

/** Agents only: terminals whose program reports a status, or that run Claude. */
export async function coreAgents(core: CoreClient, sessions: SessionLookup, host?: string): Promise<CoreAgentRow[]> {
  const { terminals } = await core.terminalList();
  const agents = onHost(terminals, host).filter((t) => t.state === "live" && (t.app !== "" || t.status !== null));
  return Promise.all(agents.map((t) => coreAgentRow(t, sessions)));
}

// --- layout rows ------------------------------------------------------------

export interface CoreSpaceRow {
  engine: "core";
  workspaceId: string;
  label: string;
  cwd: string | null;
  machine: string | null;
  active: boolean;
  tabCount: number;
  paneCount: number;
}

export interface CoreTabRow {
  engine: "core";
  tabId: string;
  workspaceId: string;
  label: string;
  /** 1-based position in its space - what `<space>:<n>` handles count. */
  number: number;
  active: boolean;
  terminals: string[];
  machine: string | null;
}

export interface CorePaneRow {
  engine: "core";
  paneId: string;
  workspaceId: string;
  tabId: string;
  terminal: string;
  agent: string;
  status: string | null;
  name: string | null;
  machine: string | null;
}

export function spaceRow(space: AppSpace): CoreSpaceRow {
  return {
    engine: "core",
    workspaceId: space.id,
    label: space.name,
    cwd: space.folder,
    machine: space.machine,
    active: space.active,
    tabCount: space.tabs.length,
    paneCount: space.tabs.reduce((n, tab) => n + tab.terminals.length, 0),
  };
}

export function tabRows(space: AppSpace): CoreTabRow[] {
  return space.tabs.map((tab, index) => ({
    engine: "core",
    tabId: tab.id,
    workspaceId: space.id,
    label: tab.name,
    number: index + 1,
    active: tab.active,
    terminals: tab.terminals.map((t) => t.terminal),
    machine: space.machine,
  }));
}

export function paneRows(space: AppSpace): CorePaneRow[] {
  return space.tabs.flatMap((tab) =>
    tab.terminals.map((t) => ({
      engine: "core" as const,
      paneId: t.pane,
      workspaceId: space.id,
      tabId: tab.id,
      terminal: t.terminal,
      agent: t.app ?? "",
      status: t.status,
      name: t.name,
      machine: space.machine,
    })),
  );
}

function findSpace(spaces: AppSpace[], id: string): AppSpace {
  const space = spaces.find((s) => s.id === id);
  if (!space) throw new CoreError("not_found", `no Herdr app space "${id}" - herdr_workspace{action:'list'} lists them`);
  return space;
}

export async function coreSpaces(core: CoreClient, host?: string): Promise<CoreSpaceRow[]> {
  return onHost((await core.appSpaces()).map(spaceRow), host);
}

export async function coreSpace(core: CoreClient, id: string): Promise<CoreSpaceRow> {
  return spaceRow(findSpace(await core.appSpaces(), id));
}

export async function coreTabs(core: CoreClient, workspaceId?: string): Promise<CoreTabRow[]> {
  const spaces = await core.appSpaces();
  return (workspaceId ? [findSpace(spaces, workspaceId)] : spaces).flatMap(tabRows);
}

export async function coreTab(core: CoreClient, tabId: string): Promise<CoreTabRow> {
  const tab = (await coreTabs(core)).find((t) => t.tabId === tabId);
  if (!tab) throw new CoreError("not_found", `no Herdr app tab "${tabId}" - herdr_tab{action:'list'} lists them`);
  return tab;
}

export async function corePanes(core: CoreClient, workspaceId?: string): Promise<CorePaneRow[]> {
  const spaces = await core.appSpaces();
  return (workspaceId ? [findSpace(spaces, workspaceId)] : spaces).flatMap(paneRows);
}

export async function corePane(core: CoreClient, paneId: string): Promise<CorePaneRow> {
  const pane = (await corePanes(core)).find((p) => p.paneId === paneId);
  if (!pane) throw new CoreError("not_found", `no Herdr app pane "${paneId}" - herdr_pane{action:'list'} lists them`);
  return pane;
}

/** The id a `herdr-app do` reply names under `key`, if it named one. */
export function replyId(reply: Record<string, unknown>, key: string): string | null {
  const value = reply[key];
  return typeof value === "string" && value !== "" ? value : null;
}

