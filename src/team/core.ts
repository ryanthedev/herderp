// core.ts: the I/O half of herdr_team. A team is a Herdr app space whose
// members are Claude (or other agent) sessions in tabs; roster.ts holds the
// rules, this file carries them out through CoreClient:
//
//   start    terminal.run through the user's login shell (labels set at
//            birth, never parented, their own environment) -> wait for
//            the window to give it a tab -> rename the tab
//   roster   terminal.list + the window's tabs + each member's screen, last
//            reply and transcript time -> roster.ts's tree
//   watch    a member and everyone under it -> one `herderp watch` command
//   recycle  start a successor from the old member's own labels and launch
//            line, re-point its reports, mark the old one retired
//   cleanup  close the tab, end and remove the terminal - only for members
//            of the named space that a team started, never the caller
//
// Invariants:
//   - Mutations touch this machine's terminals only (`ska/t7` is refused).
//   - recycle and cleanup act only on labelled members (role, job or
//     reports-to) of one space: the caller's, or the one named. A `retired`
//     label alone proves nothing.
//   - Nothing is ever chosen for cleanup by status or by tab text: `done`
//     only means a turn ended. The marker is the `retired` label, a finished
//     program, or an explicit target - and every one still passes the guards.
//   - After a successor or new member is running, later steps never throw:
//     a failed rename or label becomes a warning, so its id is always returned.
//   - Clocks and sleeps are injected; nothing here reads Date or sets timers.

import { isAbsolute, join } from "node:path";
import { stat } from "node:fs/promises";
import type { CoreClient } from "../core/client.js";
import { isAtShell, isClaudeTerminal, type SessionLookup } from "../core/sessions.js";
import { CoreError, type AppSpace, type CoreTerminal } from "../core/types.js";
import { cleanLaunch } from "../bridge/cleanenv.js";
import { buildWatchCommand, MONITOR_MAX_TIMEOUT_MS } from "../watch/command.js";
import { deriveSlug } from "../necromancy/core.js";
import {
  buildRoster,
  carriedFlags,
  extractFlags,
  isTeamMember,
  jobOf,
  LABEL_JOB,
  LABEL_REPORTS_TO,
  LABEL_RETIRED,
  LABEL_ROLE,
  LABEL_SPACE,
  loginLaunch,
  reportsToKey,
  reportsToOf,
  stripEnvWrapper,
  subtreeOf,
  withPrompt,
  type MemberFacts,
  type Roster,
} from "./roster.js";

/** How long start waits for the window to show the new terminal's tab. */
export const TAB_WAIT_MS = 10_000;
const TAB_POLL_MS = 250;

export interface TeamDeps {
  core: CoreClient;
  sessions: SessionLookup;
  /** The caller's environment: HC_TERMINAL_ID says who is calling; passEnv copies from it. */
  env?: NodeJS.ProcessEnv;
  /** The agent's last reply of its own, or undefined. */
  lastReply: (sessionId: string, cwd: string) => Promise<string | undefined>;
  /** When the session's transcript last moved (ms), or null. */
  activityAt: (sessionId: string, cwd: string) => Promise<number | null>;
  fileExists: (path: string) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export interface StartArgs {
  kind: string;
  prompt?: string;
  brief?: string;
  role?: string;
  job?: string;
  tabLabel?: string;
  space?: string;
  reportsTo?: string;
  labels?: Record<string, string>;
  settings?: string;
  pluginDirs?: string[];
  argv?: string[];
  cwd?: string;
  passEnv?: string[];
}

export interface Started {
  target: string;
  tabId: string | null;
  tabLabel: string;
  spaceId: string;
  labels: Record<string, string>;
  argv: string[];
  envPassed: string[];
  envMissing: string[];
  warnings: string[];
}

export interface Team {
  start(args: StartArgs): Promise<Started>;
  roster(args: { space?: string; stallMs?: number; drafts?: boolean }): Promise<Roster & { space: { id: string; name: string }; you: string | null }>;
  watch(args: { target: string; stallMs?: number; once?: boolean; json?: boolean; verbose?: boolean }): Promise<{
    command: string;
    description: string;
    timeout_ms: number;
    targets: Array<{ target: string; status: string }>;
    skipped: Array<{ target: string; reason: string }>;
  }>;
  recycle(args: { target?: string; space?: string; handoff: string; prompt?: string; passEnv?: string[] }): Promise<{
    successor: { target: string; tabId: string | null; tabLabel: string };
    retired: string;
    repointed: string[];
    self: boolean;
    warnings: string[];
  }>;
  cleanup(args: { space?: string; targets?: string[]; dryRun?: boolean; force?: boolean }): Promise<{
    dryRun: boolean;
    closed: Array<{ target: string; tabClosed: boolean; gone: boolean | null }>;
    skipped: Array<{ target: string; reason: string }>;
  }>;
}

/** Labels a caller may not pass as extras: the window's own, and the ones this tool sets from named fields. */
const RESERVED_LABELS: ReadonlySet<string> = new Set(["where", LABEL_REPORTS_TO, LABEL_RETIRED, LABEL_JOB, LABEL_ROLE]);

function teamError(code: string, message: string): CoreError {
  return new CoreError(code, message);
}

function isAgent(terminal: CoreTerminal): boolean {
  return terminal.state === "live" && (terminal.app !== "" || terminal.status !== null) && !isAtShell(terminal);
}

/**
 * The Claude Code command line a terminal runs: its launch line, or - for a
 * session typed into a tab's shell, whose launch line is the shell - the line
 * in the foreground now. Null when it is not Claude Code.
 */
export function claudeLineOf(terminal: CoreTerminal): string[] | null {
  const isClaudeLine = (argv: string[]) => isClaudeTerminal({ ...terminal, foreground: { pid: 0, argv, cwd: "" } });
  const launched = stripEnvWrapper(terminal.argv);
  if (isClaudeLine(launched)) return launched;
  const running = terminal.foreground ? stripEnvWrapper(terminal.foreground.argv) : [];
  return isClaudeLine(running) ? running : null;
}

/** terminal address -> the tab showing it, across the window's spaces. */
function tabIndex(spaces: AppSpace[]): Map<string, { tabId: string; tabLabel: string; spaceId: string; alone: boolean }> {
  const index = new Map<string, { tabId: string; tabLabel: string; spaceId: string; alone: boolean }>();
  for (const space of spaces) {
    for (const tab of space.tabs) {
      for (const ref of tab.terminals) {
        const address = space.machine === null || ref.terminal.includes("/") ? ref.terminal : `${space.machine}/${ref.terminal}`;
        index.set(address, { tabId: tab.id, tabLabel: tab.name, spaceId: space.id, alone: tab.terminals.length === 1 });
      }
    }
  }
  return index;
}

export function createTeam(deps: TeamDeps): Team {
  const { core } = deps;
  const callerId = (): string | null => deps.env?.HC_TERMINAL_ID || null;

  async function callerTerminal(): Promise<CoreTerminal | null> {
    const id = callerId();
    if (id === null) return null;
    try {
      return await core.terminalGet(id);
    } catch (error) {
      if (error instanceof CoreError) return null;
      throw error;
    }
  }

  /** A space by id or unique name; default the caller's own. */
  async function resolveSpace(space: string | undefined, action: string, spaces?: AppSpace[]): Promise<AppSpace> {
    const all = spaces ?? (await core.appSpaces());
    let wanted = space;
    if (wanted === undefined || wanted === "") {
      wanted = (await callerTerminal())?.spaceId ?? undefined;
      if (wanted === undefined) {
        throw new Error(`herdr_team{action:"${action}"} requires "space" (this session is not in a Herdr app space, so there is no default)`);
      }
    }
    const byId = all.find((s) => s.id === wanted);
    if (byId) return byId;
    const byName = all.filter((s) => s.name === wanted);
    if (byName.length === 1) return byName[0]!;
    if (byName.length > 1) {
      throw teamError("ambiguous_space", `${byName.length} spaces are named "${wanted}" - pass a space id (${byName.map((s) => s.id).join(", ")})`);
    }
    throw teamError("not_found", `no Herdr app space "${wanted}" - herdr_workspace{action:'list'} lists them`);
  }

  function requireLocal(address: string, action: string): void {
    if (address.includes("/")) {
      throw teamError("unsupported_remote", `herdr_team{action:"${action}"} works on this machine's terminals only, and ${address} is on another machine`);
    }
  }

  /** Values for `names` from the caller's environment; names that are unset come back as missing. */
  function pickEnv(names: string[] | undefined): { env: Record<string, string>; passed: string[]; missing: string[] } {
    const env: Record<string, string> = {};
    const missing: string[] = [];
    for (const name of names ?? []) {
      const value = deps.env?.[name];
      if (value === undefined || value === "") missing.push(name);
      else env[name] = value;
    }
    return { env, passed: Object.keys(env), missing };
  }

  /**
   * Starts one terminal with its labels and gives it a named tab. Throws only
   * if the terminal itself does not start; the tab steps degrade to warnings.
   */
  async function launch(opts: {
    argv: string[];
    cwd: string;
    labels: Record<string, string>;
    spaceId: string;
    tabLabel: string;
    passEnv?: string[];
  }): Promise<Started> {
    const picked = pickEnv(opts.passEnv);
    // cleanLaunch: a core started from a Claude shell would otherwise hand the
    // new Claude that session's markers, and it would save no transcript.
    // loginLaunch: the core starts programs with no shell profile, so the user's own environment is loaded first.
    const terminal = await core.terminalRun({
      argv: loginLaunch(cleanLaunch(opts.argv), deps.env?.SHELL),
      cwd: opts.cwd,
      labels: opts.labels,
      env: picked.env,
    });
    const warnings: string[] = [];
    let tabId: string | null = null;
    // A fresh terminal carries no `herdr.tab` label; the window is asked instead.
    for (let waited = 0; waited <= TAB_WAIT_MS && tabId === null; waited += TAB_POLL_MS) {
      try {
        tabId = tabIndex(await core.appSpaces()).get(terminal.address)?.tabId ?? null;
      } catch (error) {
        if (!(error instanceof CoreError)) throw error;
        warnings.push(`the Herdr window did not answer (${error.code}), so the tab was not renamed`);
        break;
      }
      if (tabId === null) await deps.sleep(TAB_POLL_MS);
    }
    if (tabId === null && warnings.length === 0) {
      warnings.push(`the window showed no tab for ${terminal.address} within ${TAB_WAIT_MS / 1000}s, so it was not renamed`);
    }
    if (tabId !== null) {
      try {
        await core.appDo("tab.rename", { id: tabId, name: opts.tabLabel });
      } catch (error) {
        if (!(error instanceof CoreError)) throw error;
        warnings.push(`tab ${tabId} was not renamed: ${error.message}`);
      }
    }
    return {
      target: terminal.address,
      tabId,
      tabLabel: opts.tabLabel,
      spaceId: opts.spaceId,
      labels: opts.labels,
      argv: opts.argv,
      envPassed: picked.passed,
      envMissing: picked.missing,
      warnings,
    };
  }

  return {
    async start(args) {
      const action = "start";
      const prompt = args.prompt ?? (args.brief ? `Read ${args.brief} and do it.` : undefined);
      if (prompt === undefined || prompt === "") throw new Error(`herdr_team{action:"start"} requires "prompt" or "brief"`);
      const tabLabel = args.tabLabel || [args.role, args.job].filter(Boolean).join(" ");
      if (tabLabel === "") throw new Error(`herdr_team{action:"start"} requires "role", "job" or "tabLabel" (a tab is never left as a bare number)`);
      for (const key of Object.keys(args.labels ?? {})) {
        if (key.startsWith("herdr.") || RESERVED_LABELS.has(key)) {
          throw new Error(`herdr_team{action:"start"}: label "${key}" is set by the tool or the window - use the named field (role, job, reportsTo, space) or drop it`);
        }
      }
      const self = await callerTerminal();
      const space = await resolveSpace(args.space, action);
      if (space.machine !== null) {
        throw teamError("unsupported_remote", `herdr_team{action:"start"} starts members on this machine only, and space "${space.name}" lives on ${space.machine}`);
      }

      let reportsTo: string | null;
      if (args.reportsTo === "none") reportsTo = null;
      else if (args.reportsTo) reportsTo = (await core.terminalGet(args.reportsTo)).address;
      else if (self) reportsTo = self.address;
      else throw new Error(`herdr_team{action:"start"} requires "reportsTo" (a terminal id, or "none" for the top of the tree) - this session is not a Herdr app terminal, so there is no default`);

      const explicitPlugins = args.settings !== undefined || args.pluginDirs !== undefined;
      if (explicitPlugins && args.kind !== "claude") {
        throw new Error(`herdr_team{action:"start"}: "settings" and "pluginDirs" are Claude Code flags - drop them for kind "${args.kind}", or put that agent's own flags in "argv"`);
      }
      let plugins: string[] = [];
      if (args.kind === "claude") {
        plugins = explicitPlugins
          ? [...(args.settings ? ["--settings", args.settings] : []), ...(args.pluginDirs ?? []).flatMap((dir) => ["--plugin-dir", dir])]
          : self
            ? extractFlags(claudeLineOf(self) ?? [])
            : [];
      }
      const cwd = args.cwd || self?.cwd || space.folder;
      if (!cwd) throw new Error(`herdr_team{action:"start"} requires "cwd" (neither this session nor the space has a folder to default to)`);

      const labels: Record<string, string> = {
        ...args.labels,
        [LABEL_SPACE]: space.id,
        ...(args.role ? { [LABEL_ROLE]: args.role } : {}),
        ...(args.job ? { [LABEL_JOB]: args.job } : {}),
        ...(reportsTo ? { [LABEL_REPORTS_TO]: reportsTo } : {}),
      };
      return launch({
        argv: withPrompt([args.kind, ...plugins, ...(args.argv ?? [])], prompt, args.kind === "claude"),
        cwd,
        labels,
        spaceId: space.id,
        tabLabel,
        passEnv: args.passEnv,
      });
    },

    async roster(args) {
      const [listing, spaces] = await Promise.all([
        core.terminalList(),
        core.appSpaces().catch((error: unknown) => {
          if (error instanceof CoreError) return null; // window down: the tree still stands, without tab names
          throw error;
        }),
      ]);
      const self = callerId();
      let spaceId: string;
      let spaceName: string;
      if (spaces !== null) {
        const space = await resolveSpace(args.space, "roster", spaces);
        spaceId = space.id;
        spaceName = space.name;
      } else {
        const own = listing.terminals.find((t) => t.address === self)?.spaceId;
        const wanted = args.space || own;
        if (!wanted) throw new Error(`herdr_team{action:"roster"} requires "space" (this session is not in a Herdr app space, so there is no default)`);
        spaceId = wanted;
        spaceName = "";
      }
      const tabs = tabIndex(spaces ?? []);
      const members = listing.terminals.filter((t) => t.spaceId === spaceId && isAgent(t));
      const facts = await Promise.all(
        members.map(async (t): Promise<MemberFacts> => {
          const tab = tabs.get(t.address);
          const [screen, session] = await Promise.all([
            core.terminalRead(t.address, { lines: 0 }).then(
              (read) => read.text,
              () => null,
            ),
            deps.sessions(t).catch(() => null),
          ]);
          const [lastReply, activityAt] = session
            ? await Promise.all([
                deps.lastReply(session, t.cwd).then(
                  (text) => text ?? null,
                  () => null,
                ),
                deps.activityAt(session, t.cwd).catch(() => null),
              ])
            : [null, null];
          return {
            target: t.address,
            labels: t.labels,
            status: t.status,
            blockedKind: t.blockedKind,
            message: t.message,
            turn: t.turn,
            createdMs: t.createdMs,
            tabId: tab?.tabId ?? t.tabId,
            tabLabel: tab?.tabLabel ?? null,
            screen,
            lastReply,
            activityAt,
          };
        }),
      );
      const roster = buildRoster(facts, {
        now: deps.now(),
        stallMs: args.stallMs,
        drafts: args.drafts,
        live: new Set(listing.terminals.filter((t) => t.state === "live").map((t) => t.address)),
        you: self,
      });
      if (spaces === null) roster.warnings.push("the Herdr window did not answer, so tab ids and tab labels are missing");
      return { space: { id: spaceId, name: spaceName }, ...roster, you: self };
    },

    async watch(args) {
      const { terminals } = await core.terminalList();
      const root = terminals.find((t) => t.address === args.target || (t.name !== null && t.name === args.target));
      if (!root) throw teamError("not_found", `no live Herdr app terminal "${args.target}" - herdr_team{action:'roster'} lists a team`);
      const byAddress = new Map(terminals.map((t) => [t.address, t]));
      const targets: Array<{ target: string; status: string }> = [];
      const skipped: Array<{ target: string; reason: string }> = [];
      for (const address of subtreeOf(terminals.map((t) => ({ target: t.address, labels: t.labels })), root.address)) {
        const t = byAddress.get(address);
        // The watcher exits on the first target it can't resolve, so only live agents go in.
        if (!t || t.state !== "live") skipped.push({ target: address, reason: "its program has ended" });
        else if (isAtShell(t)) skipped.push({ target: address, reason: "back at its shell (the agent exited)" });
        else targets.push({ target: address, status: t.status ?? "unknown" });
      }
      if (targets.length === 0) throw teamError("nothing_to_watch", `${root.address} and everyone under it have exited - nothing to watch`);
      return {
        command: buildWatchCommand({
          targets: targets.map((t) => `core:${t.target}`),
          stallMs: args.stallMs,
          once: args.once,
          json: args.json,
          verbose: args.verbose,
        }),
        description: `team under ${root.address}: ${targets.map((t) => t.target).join(", ")}`,
        timeout_ms: MONITOR_MAX_TIMEOUT_MS,
        targets,
        skipped,
      };
    },

    async recycle(args) {
      const action = "recycle";
      const oldId = args.target || callerId();
      if (!oldId) throw new Error(`herdr_team{action:"recycle"} requires "target" (this session is not a Herdr app terminal, so there is no default)`);
      const old = await core.terminalGet(oldId);
      requireLocal(old.address, action);
      if (old.spaceId === null) throw teamError("not_a_member", `${old.address} is in no Herdr app space (no ${LABEL_SPACE} label), so it is on no team`);
      // The team is the caller's own space unless one is named: a wrong id must not reach into someone else's.
      let teamSpace = (await callerTerminal())?.spaceId ?? null;
      let spaces: AppSpace[] | null = null;
      if (args.space) {
        spaces = await core.appSpaces();
        teamSpace = (await resolveSpace(args.space, action, spaces)).id;
      }
      if (teamSpace === null) {
        throw new Error(`herdr_team{action:"recycle"} requires "space" (this session is not in a Herdr app space, so name the team the target is on)`);
      }
      if (old.spaceId !== teamSpace) {
        throw teamError("outside_team", `${old.address} is not in ${args.space ? `space "${args.space}"` : "your space"} - recycle works inside one team; pass space to name another team you run`);
      }
      if (!isTeamMember(old.labels)) {
        throw teamError("not_a_member", `${old.address} carries no team label (role, job or reports-to), so it is somebody's own session, not a member - it was not touched`);
      }
      if (old.labels[LABEL_RETIRED]) throw teamError("already_retired", `${old.address} already handed off to ${old.labels[LABEL_RETIRED]}`);
      const line = claudeLineOf(old);
      if (line === null) {
        throw teamError("unsupported_agent", `herdr_team{action:"recycle"} only knows Claude Code launch lines, and ${old.address} was started as "${stripEnvWrapper(old.argv)[0] ?? "?"}" - start its successor with action:'start'`);
      }
      const handoff = isAbsolute(args.handoff) ? args.handoff : join(old.cwd, args.handoff);
      if (!(await deps.fileExists(handoff))) throw teamError("no_handoff", `hand-off file ${handoff} does not exist - write it first, then recycle`);

      const oldTab = tabIndex(spaces ?? (await core.appSpaces())).get(old.address);
      const role = old.labels[LABEL_ROLE] || null;
      const job = jobOf(old.labels);
      const tabLabel = (oldTab?.tabLabel && !/^\d+$/.test(oldTab.tabLabel) ? oldTab.tabLabel : "") || [role, job].filter(Boolean).join(" ") || `successor of ${old.address}`;
      // The window owns herdr.* (tab, seen) and `where`; only the space carries over.
      const labels: Record<string, string> = {};
      for (const [key, value] of Object.entries(old.labels)) {
        if (key === "where" || (key.startsWith("herdr.") && key !== LABEL_SPACE)) continue;
        labels[key] = value;
      }
      const prompt = args.prompt || `Read ${args.handoff} and continue as ${[role, job].filter(Boolean).join(" ") || tabLabel}.`;

      // Nothing above changed anything; from here the successor exists, so nothing below throws.
      const started = await launch({
        argv: withPrompt([line[0]!, ...carriedFlags(line)], prompt, true),
        cwd: old.cwd,
        labels,
        spaceId: old.spaceId,
        tabLabel,
        passEnv: args.passEnv,
      });
      const warnings = [...started.warnings];
      const attempt = async (what: string, run: () => Promise<unknown>): Promise<boolean> => {
        try {
          await run();
          return true;
        } catch (error) {
          if (!(error instanceof CoreError)) throw error;
          warnings.push(`${what}: ${error.message}`);
          return false;
        }
      };

      const repointed: string[] = [];
      let listing: CoreTerminal[] = [];
      await attempt("could not list terminals to re-point reports", async () => {
        listing = (await core.terminalList()).terminals;
      });
      for (const t of listing) {
        const key = reportsToKey(t.labels);
        // Local only: on another machine, reports-to=<this id> names that machine's own terminal.
        if (key === null || t.labels[key] !== old.address || t.address === started.target || t.address.includes("/")) continue;
        if (await attempt(`${t.address} still reports to ${old.address}`, () => core.terminalLabel(t.address, { [key]: started.target }))) {
          repointed.push(t.address);
        }
      }
      // ROLES.md: the new leader is labelled first (at its start, above), then the old one loses the label.
      await attempt(`${old.address} was not labelled retired`, () =>
        core.terminalLabel(old.address, { [LABEL_RETIRED]: started.target, ...(role === "orchestrator" ? { [LABEL_ROLE]: "" } : {}) }),
      );
      if (oldTab) {
        await attempt(`${old.address}'s tab was not renamed`, () => core.appDo("tab.rename", { id: oldTab.tabId, name: `retired ${tabLabel}` }));
      }
      return {
        successor: { target: started.target, tabId: started.tabId, tabLabel },
        retired: old.address,
        repointed,
        self: old.address === callerId(),
        warnings,
      };
    },

    async cleanup(args) {
      const action = "cleanup";
      const spaces = await core.appSpaces();
      const space = await resolveSpace(args.space, action, spaces);
      const { terminals } = await core.terminalList({ all: true });
      const byAddress = new Map(terminals.map((t) => [t.address, t]));
      const self = callerId();
      const tabs = tabIndex(spaces);

      const skipped: Array<{ target: string; reason: string }> = [];
      let candidates: CoreTerminal[];
      if (args.targets && args.targets.length > 0) {
        candidates = [];
        for (const id of args.targets) {
          const t = byAddress.get(id) ?? terminals.find((x) => x.name !== null && x.name === id);
          if (t) candidates.push(t);
          else skipped.push({ target: id, reason: "no such terminal (already removed?)" });
        }
      } else {
        candidates = terminals.filter((t) => t.spaceId === space.id && isTeamMember(t.labels) && (Boolean(t.labels[LABEL_RETIRED]) || t.state !== "live"));
      }

      let approved: CoreTerminal[] = [];
      for (const t of candidates) {
        let reason: string | null = null;
        if (t.address === self) reason = "that is you - your parent cleans you up";
        else if (t.address.includes("/")) reason = "on another machine";
        else if (t.spaceId !== space.id) reason = `not in space "${space.name}"`;
        else if (!isTeamMember(t.labels)) reason = "not a team member (no role, job or reports-to label) - close it yourself if it is yours";
        else if (t.state === "live" && t.status === "working" && !args.force) reason = "still working - pass force:true to end it anyway";
        if (reason !== null) skipped.push({ target: t.address, reason });
        else approved.push(t);
      }
      // A member with live reports stays, unless every one of them is being closed too.
      // Repeat until stable: refusing one member can leave its own parent with a report.
      for (let changed = true; changed; ) {
        changed = false;
        const closing = new Set(approved.map((t) => t.address));
        for (const t of approved) {
          const reports = terminals.filter((x) => x.state === "live" && reportsToOf(x.labels) === t.address && !closing.has(x.address));
          if (reports.length === 0) continue;
          skipped.push({ target: t.address, reason: `still has reports (${reports.map((x) => x.address).join(", ")}) - recycle it, or clean them up first` });
          approved = approved.filter((x) => x !== t);
          changed = true;
          break;
        }
      }
      if (args.dryRun) {
        return { dryRun: true, closed: approved.map((t) => ({ target: t.address, tabClosed: tabs.get(t.address)?.alone === true, gone: null })), skipped };
      }

      const closed: Array<{ target: string; tabClosed: boolean; gone: boolean | null }> = [];
      /** Each step may find its work already done by the one before; what counts is the check at the end. */
      const tolerate = async (run: () => Promise<unknown>): Promise<boolean> => {
        try {
          await run();
          return true;
        } catch (error) {
          if (!(error instanceof CoreError)) throw error;
          return false;
        }
      };
      let latest = tabs;
      for (const t of approved) {
        // Asked again for each one: earlier closes take seconds, and tab.close ends every terminal
        // in the tab - so only a tab this member has to itself right now is closed.
        const tab = (await tolerate(async () => void (latest = tabIndex(await core.appSpaces())))) ? latest.get(t.address) : undefined;
        const tabClosed = tab?.alone === true && (await tolerate(() => core.appDo("tab.close", { id: tab.tabId, confirmed: true })));
        await tolerate(() => core.terminalKill(t.address));
        await tolerate(() => core.terminalRm(t.address));
        closed.push({ target: t.address, tabClosed, gone: null });
      }
      if (closed.length > 0) {
        const after = await core.terminalList({ all: true }).catch((error: unknown) => {
          if (error instanceof CoreError) return null;
          throw error;
        });
        if (after !== null) {
          const left = new Set(after.terminals.map((t) => t.address));
          for (const row of closed) row.gone = !left.has(row.target);
        }
      }
      return { dryRun: false, closed, skipped };
    },
  };
}

/** The real `activityAt`: the mtime of the session's transcript under ~/.claude/projects. */
export function transcriptActivity(projectsRoot: string): TeamDeps["activityAt"] {
  return async (sessionId, cwd) => {
    try {
      return (await stat(join(projectsRoot, deriveSlug(cwd), `${sessionId}.jsonl`))).mtimeMs;
    } catch {
      return null;
    }
  };
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
