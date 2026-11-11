// bridged.ts: the routing half of the curated tools once herdr-core is in
// play. curated.ts owns each tool's schema and its herdr handler; this file
// decides, per call, which engine answers - and carries out the calls that
// go to herdr-core (`hc`) or to the Herdr app's window (`herdr-app`), plus the
// list calls that span both.
//
// Routes:
//   - "herdr" / "core": one engine, decided by `engine`, an id's shape, or
//     (for calls that create something) the caller's home engine;
//   - "both": lists - each engine's rows, tagged `engine`, merged; an engine
//     that is down adds a `degraded` entry instead of failing the call;
//   - "resolve": a bare agent name, looked up in both (bridge/resolve.ts).

import type { HerdrClient } from "../herdr/client.js";
import { HerdrError } from "../herdr/types.js";
import type { ToolResult } from "../registry.js";
import { CoreError } from "../core/types.js";
import { machineOf } from "../core/client.js";
import { engineOfId, pickEngine, qualifyCore, type Engine } from "../bridge/route.js";
import { resolveAgentTarget } from "../bridge/resolve.js";
import { adoptAgent } from "../bridge/adopt.js";
import { isNotInstalled } from "../bridge/absent.js";
import { cleanLaunch } from "../bridge/cleanenv.js";
import { callerOf, isCaller, markCaller, youSummary } from "../bridge/self.js";
import { planBridgedWatch } from "../watch/command.js";
import type { BridgeDeps } from "./curated.js";
import {
  onHost,
  coreAgentRow,
  coreAgents,
  corePane,
  corePanes,
  coreSpace,
  coreSpaces,
  coreTab,
  coreTabs,
  replyId,
  unsupported,
} from "./core.js";

export type Route = "herdr" | "core" | "both" | "resolve";

/** A tool's non-herdr side: route, the call's args, and a lazy herdr client. */
export type CoreHandler = (route: Exclude<Route, "herdr">, args: never, herdr: never) => Promise<ToolResult>;

type HerdrThunk<A> = () => Promise<{ client: HerdrClient; run: (args: A) => Promise<ToolResult> }>;

export interface Degraded {
  engine: Engine;
  code: string;
  message: string;
  absent?: boolean;
}

/** Runs one engine's half of a list; an engine error becomes a `degraded` entry. */
async function half<T>(engine: Engine, run: () => Promise<T[]>, degraded: Degraded[]): Promise<T[]> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof HerdrError || error instanceof CoreError) {
      // Not installed here: not part of this machine's answer, so not "degraded" -
      // but still recorded, so the all-engines-failed check below can see it.
      degraded.push({ engine, code: error.code, message: error.message, ...(isNotInstalled(error) && { absent: true }) });
      return [];
    }
    throw error;
  }
}

/** Both halves of a list, merged. Throws only when every engine failed. */
async function both<H, C>(
  herdrRows: () => Promise<H[]>,
  coreRows: () => Promise<C[]>,
): Promise<{ rows: Array<H | C>; degraded: Degraded[] }> {
  const degraded: Degraded[] = [];
  const [h, c] = await Promise.all([half("herdr", herdrRows, degraded), half("core", coreRows, degraded)]);
  if (degraded.length === 2) {
    const of = (engine: Engine) => degraded.find((d) => d.engine === engine)!;
    throw new CoreError(
      "engines_unreachable",
      `no engine answered (not installed counts) - herdr: [${of("herdr").code}] ${of("herdr").message}; core: [${of("core").code}] ${of("core").message}`,
    );
  }
  return { rows: [...h, ...c], degraded: degraded.filter((d) => !d.absent).map(({ absent: _, ...d }) => d) };
}

function tagged<T extends object>(rows: T[], extra: (row: T) => Record<string, unknown> = () => ({})) {
  return rows.map((row) => ({ engine: "herdr" as const, ...extra(row), ...row }));
}

function withDegraded(result: Record<string, unknown>, degraded: Degraded[]): Record<string, unknown> {
  return degraded.length > 0 ? { ...result, degraded } : result;
}

function ok(hint: string, data?: Record<string, unknown>): Record<string, unknown> {
  return { ok: true, engine: "core", ...data, hint };
}

function need<T>(value: T | undefined, field: string, tool: string, action: string): T {
  if (value === undefined || value === "") throw new Error(`${tool}{action:"${action}"} requires "${field}"`);
  return value;
}

/** `until` on core: hc waits until the agent is not working - one rule, no state list. */
function rejectUntil(until: unknown, tool: string, action: string): void {
  if (until !== undefined) {
    throw new CoreError(
      "unsupported_on_core",
      `${tool}{action:"${action}"}: a Herdr app agent waits until it stops working (any word but working, or it exits) - drop "until"`,
    );
  }
}

// --- herdr_agent ------------------------------------------------------------

export interface AgentArgs {
  action: string;
  engine?: Engine;
  host?: string;
  target?: string;
  targets?: string[];
  text?: string;
  keys?: string[];
  lines?: number;
  wait?: boolean;
  until?: unknown;
  timeoutMs?: number;
  kind?: string;
  argv?: string[];
  name?: string;
  cwd?: string;
  place?: "tab" | "right" | "down";
  paneId?: string;
  workspaceId?: string;
  label?: string;
  stallMs?: number;
  once?: boolean;
  json?: boolean;
  verbose?: boolean;
  [key: string]: unknown;
}

export function agentRoute(args: AgentArgs, env?: NodeJS.ProcessEnv): Route {
  switch (args.action) {
    case "list":
      return args.engine ?? "both";
    case "watch":
    case "adopt":
      return "core"; // both handled in coreAgentTool: watch spans engines, adopt is herdr -> core
    case "start":
      return pickEngine(args.engine, [args.paneId, args.workspaceId], env, args.host);
    default:
      if (args.engine) return args.engine;
      if (args.target === undefined || args.target === "") return "herdr"; // let the herdr handler name the missing field
      return engineOfId(args.target) ?? "resolve";
  }
}

export function coreAgentTool(bridge: BridgeDeps) {
  const { core, sessions } = bridge;
  const tool = "herdr_agent";
  return async (route: Exclude<Route, "herdr">, args: AgentArgs, herdr: HerdrThunk<AgentArgs>): Promise<ToolResult> => {
    if (args.action === "list") {
      const caller = callerOf(bridge.env);
      if (route === "core") {
        const agents = markCaller(await coreAgents(core, sessions, args.host), caller, args.host);
        return { you: youSummary(agents, caller, args.host), agents, hint: LIST_HINT };
      }
      const { rows, degraded } = await both(
        async () => tagged(await (await herdr()).client.agentList(), (a) => ({ target: a.paneId })),
        () => coreAgents(core, sessions, args.host),
      );
      const agents = markCaller(rows as Array<{ engine?: string; target?: string; machine?: string | null }>, caller, args.host);
      return withDegraded({ you: youSummary(agents, caller, args.host), agents, hint: LIST_HINT }, degraded);
    }
    if (args.action === "watch") {
      const targets = [...(args.targets ?? []), ...(args.target ? [args.target] : [])];
      if (targets.length === 0) throw new Error(`${tool}{action:"watch"} requires "target" or "targets"`);
      if (args.host !== undefined && args.host !== "" && args.host !== "local") {
        throw new Error(`${tool}{action:"watch"} runs on this machine only - drop host (remote watch is not supported yet)`);
      }
      const resolved = [];
      for (const target of targets) resolved.push(await resolveAgentTarget(target, { engine: args.engine }, resolveDeps(herdr)));
      const herdrClient = resolved.some((r) => r.engine === "herdr") ? (await herdr()).client : undefined;
      return {
        ...(await planBridgedWatch({ herdr: herdrClient, core }, resolved, {
          stallMs: args.stallMs,
          once: args.once,
          json: args.json,
          verbose: args.verbose,
        })),
      };
    }
    if (args.action === "adopt") {
      if (args.host !== undefined && args.host !== "" && args.host !== "local") {
        throw new Error(`${tool}{action:"adopt"} works on this machine only - Claude's session files live here - drop host`);
      }
      const { client } = await herdr();
      return {
        ...(await adoptAgent(
          { target: need(args.target, "target", tool, "adopt"), workspaceId: args.workspaceId, label: args.label },
          { herdr: client, core, sessions, ...bridge.adopt },
        )),
      };
    }

    let target: string | undefined = args.target;
    let engine: Engine = route === "core" ? "core" : "herdr";
    if (route === "resolve") {
      const resolved = await resolveAgentTarget(
        need(args.target, "target", tool, args.action),
        { host: args.host, mutating: !READ_ONLY_ACTIONS.has(args.action) },
        resolveDeps(herdr),
      );
      engine = resolved.engine;
      target = resolved.target;
    } else if (route === "core" && target !== undefined) {
      target = qualifyCore(target, args.host);
    }
    if (engine === "herdr") {
      const { run } = await herdr();
      const result = await run({ ...args, target });
      return typeof result === "string" ? result : { engine: "herdr", ...result };
    }
    return coreAgentAction(args, target);
  };

  /** herdr is reached through this call's own host-bound client, made only if needed. */
  function resolveDeps(herdr: HerdrThunk<AgentArgs>) {
    return { herdr: { clientFor: async () => (await herdr()).client }, core };
  }

  /**
   * hc tags every send that crosses machines (`<hc from="mac/ppid:1">`), signed or
   * not, and a tagged /reload-plugins is only a message: on 2026-11-11 a dozen
   * agents on ska and vana answered it instead of running it. So a command for
   * another machine's terminal is sent from that machine (`hc exec --on`), with
   * no caller of its own, which arrives untagged.
   */
  async function sendCommandOnMachine(target: string, text: string, args: AgentArgs) {
    const machine = machineOf(target)!;
    const bare = target.slice(machine.length + 1);
    const waitSec = args.wait ? (args.timeoutMs ?? 180_000) / 1000 : undefined;
    const argv = ["env", "-u", "HC_TERMINAL_ID", "-u", "HC_SCOPE", "hc", "send", "--json", ...(waitSec ? ["--wait", "--timeout", String(waitSec)] : []), bare, text];
    const out = await core.machineExec(machine, argv, { timeoutSec: Math.min(600, Math.ceil((waitSec ?? 30) + 30)) });
    if (out.code !== 0) {
      throw new CoreError("send_failed", `hc send on ${machine} failed (exit ${out.code ?? "signal"}${out.timedOut ? ", timed out" : ""}): ${(out.stderr || out.stdout).trim()}`);
    }
    const r = (() => { try { return JSON.parse(out.stdout) as Record<string, unknown>; } catch { return {}; } })();
    const wait = typeof r.wait === "object" && r.wait !== null ? (r.wait as Record<string, unknown>) : null;
    return {
      turn: typeof r.turn === "number" ? r.turn : 0,
      started: typeof r.started === "boolean" ? r.started : null,
      status: typeof r.status === "string" ? r.status : null,
      wait: wait ? { terminal: target, ended: wait.ended === true, reason: String(wait.reason ?? ""), status: (wait.status as string) ?? null, turn: Number(wait.turn ?? 0), exitCode: (wait.exit_code as number) ?? null } : null,
    };
  }

  async function coreAgentAction(args: AgentArgs, target: string | undefined): Promise<ToolResult> {
    const action = args.action;
    const t = () => need(target, "target", tool, action);
    switch (action) {
      case "get": {
        const [agent] = markCaller([await coreAgentRow(await core.terminalGet(t()), sessions)], callerOf(bridge.env));
        return { agent };
      }
      case "read": {
        rejectFields(args, [["source", isSet], ["format", isSet], ["ansi", isSet]], tool, action);
        const read = await core.terminalRead(t(), { lines: args.lines });
        return {
          engine: "core",
          text: read.text,
          complete: read.complete,
          how: read.how,
          ...(read.why ? { why: read.why } : {}),
          ...(read.complete ? {} : { hint: `only part came back (${read.why ?? read.how}); read again once it stops working` }),
        };
      }
      case "prompt": {
        rejectUntil(args.until, tool, action);
        // Name the sender, so the agent reads <hc from="t3s">...</hc> and knows who is
        // talking to it. hc only tags a send whose caller is one of its terminals.
        // A slash command or `!` shell line goes unsigned: wrapped in the tag it is just
        // a message, and on 2026-11-11 a Haiku agent answered a wrapped /reload-plugins
        // with "Plugins reloaded" without running it.
        const text = need(args.text, "text", tool, action);
        const command = isComposerCommand(text);
        const from = !command && callerOf(bridge.env).engine === "core" ? (bridge.env?.HC_TERMINAL_ID ?? null) : null;
        // Only `/` commands take the untagged cross-machine path. A `!` line would run
        // a shell on the other machine with hc's provenance tag stripped, so it keeps
        // the tag (and arrives there as a message the agent can weigh, not a command).
        const sent = command && text.trimStart().startsWith("/") && machineOf(t()) !== null
          ? await sendCommandOnMachine(t(), text, args)
          : await core.terminalSend(t(), text, {
              wait: args.wait,
              timeoutMs: args.timeoutMs,
              ...(from ? { caller: from } : {}),
            });
        const signed = from
          ? { from }
          : command
            ? { from: null, fromNote: "sent unsigned so it runs as a command (a sender tag would turn it into a plain message)" }
            : { from: null, fromNote: "sent unsigned: this session is not a Herdr app terminal, so the agent sees no sender - say who you are in the text" };
        if (args.wait) {
          return ok(
            sent.wait?.ended === false
              ? "prompt submitted; still working at the timeout - herdr_agent{action:'wait'} again"
              : "prompt submitted and the agent stopped; herdr_agent{action:'read'} to see what it produced",
            { sent, ...signed },
          );
        }
        return ok(
          sent.started === false
            ? "prompt submitted but it did not start working - herdr_agent{action:'read'} before resending (it may still have arrived)"
            : "prompt submitted; herdr_agent{action:'wait'} then {action:'read'} to collect the answer",
          { sent, ...signed },
        );
      }
      case "send_keys": {
        const keys = args.keys ?? [];
        if (keys.length === 0) throw new Error(`${tool}{action:"send_keys"} requires a non-empty "keys" (e.g. ["esc"])`);
        return ok("keys sent; herdr_agent{action:'read'} to see the result", { ...(await core.terminalKeys(t(), keys)) });
      }
      case "focus":
        await core.appDo("agent.focus", { terminal: t() });
        return ok("agent shown in the Herdr app");
      case "wait": {
        rejectUntil(args.until, tool, action);
        const waited = await core.terminalWait(t(), { timeoutMs: args.timeoutMs });
        return {
          engine: "core",
          wait: waited,
          hint: waited.ended
            ? "it stopped; herdr_agent{action:'read'} to see what it produced"
            : "still working at the timeout (a check-in, not a failure) - wait again",
        };
      }
      case "interrupt": {
        const result = await core.terminalInterrupt(t());
        return ok(`pressed ${result.key}: ${result.outcome}`, { interrupt: result });
      }
      case "start": {
        const kind = need(args.kind, "kind", tool, "start");
        rejectFields(args, [["paneId", isSet], ["timeoutMs", isSet]], tool, action);
        // Strip another session's markers: a polluted core would otherwise start a Claude that saves no transcript.
        const argv = cleanLaunch([kind, ...(args.argv ?? [])]);
        // A space means a new tab there (terminal.open only opens beside the focused pane).
        if (args.workspaceId && args.place && args.place !== "tab") {
          throw new CoreError("unsupported_on_core", `${tool}{action:"start"}: with workspaceId the Herdr app opens a new tab - drop place, or drop workspaceId to split beside the focused pane`);
        }
        const reply = args.workspaceId
          ? await core.appDo("tab.new", {
              space: args.workspaceId,
              argv,
              ...(args.cwd ? { folder: args.cwd } : {}),
              ...(args.name ? { name: args.name } : {}),
            })
          : await core.appDo("terminal.open", {
              argv,
              ...(args.cwd ? { folder: args.cwd } : {}),
              ...(args.place ? { place: args.place } : {}),
              ...(args.name ? { name: args.name } : {}),
            });
        const terminal = replyId(reply, "terminal");
        return ok(
          terminal
            ? `started in the Herdr app; herdr_agent{action:'get',target:"${terminal}"} to confirm it came up`
            : "started in the Herdr app; herdr_agent{action:'list'} to find it",
          { ...reply },
        );
      }
      case "rename":
        throw unsupported(tool, action, "a Herdr app terminal's name is set when it starts (start with name)");
      case "explain":
        throw unsupported(tool, action, "use action:'get' (status, message, blockedKind) and action:'read'");
      default:
        throw unsupported(tool, action, "see this tool's description");
    }
  }
}

/**
 * Marks the caller in a herdr agent answer (list or get), which herdr itself
 * never does. Core answers are marked where they are built; a result that
 * already carries `you` is left alone.
 */
export function markHerdrAgents(result: ToolResult, args: { action: string; host?: string }, env?: NodeJS.ProcessEnv): ToolResult {
  if (typeof result === "string" || "you" in result) return result;
  const caller = callerOf(env);
  if (args.action === "list" && Array.isArray(result.agents)) {
    const agents = (result.agents as Array<Record<string, unknown>>).map((row) =>
      isCaller({ engine: "herdr", target: row.paneId as string | undefined }, caller, args.host) ? { ...row, you: true as const } : row,
    );
    const rows = agents.map((row) => ({ ...row, target: row.paneId as string | undefined, engine: "herdr" }));
    return { you: youSummary(rows, caller, args.host), ...result, agents };
  }
  if (args.action === "get" && typeof result.agent === "object" && result.agent !== null) {
    const agent = result.agent as Record<string, unknown>;
    const mine = isCaller({ engine: "herdr", target: agent.paneId as string | undefined }, caller, args.host);
    return mine ? { ...result, agent: { ...agent, you: true } } : result;
  }
  return result;
}

/** A line the agent's composer runs itself (`/reload-plugins`, `!ls`) rather than reading as a message. */
export function isComposerCommand(text: string): boolean {
  return /^[/!]/.test(text.trimStart());
}

/** Actions that only look: a bare name found while the other engine is down may still answer these. */
const READ_ONLY_ACTIONS: ReadonlySet<string> = new Set(["get", "read", "wait", "explain"]);

/** Fails a call that sets a field the Herdr app can't honor, instead of silently dropping it. */
function rejectFields(args: Record<string, unknown>, fields: Array<[string, (v: unknown) => boolean]>, tool: string, action: string): void {
  for (const [field, set] of fields) {
    if (args[field] !== undefined && set(args[field])) {
      throw new CoreError("unsupported_on_core", `${tool}{action:"${action}"}: the Herdr app has no "${field}" here - drop it, or pass engine:"herdr"`);
    }
  }
}
const isSet = () => true;
const isFalse = (v: unknown) => v === false;

const LIST_HINT =
  "address any of these with target=<its target>, e.g. herdr_agent{action:'read',target}; engine says which engine runs it";

// --- herdr_pane ---------------------------------------------------------------

export interface LayoutArgs {
  action: string;
  engine?: Engine;
  host?: string;
  paneId?: string;
  tabId?: string;
  workspaceId?: string;
  [key: string]: unknown;
}

/** Layout routes: lists span both; everything else follows its ids or home. */
export function layoutRoute(args: LayoutArgs, env?: NodeJS.ProcessEnv): Route {
  const scoped = args.paneId ?? args.tabId ?? args.workspaceId;
  if (args.action === "list" && !args.engine && scoped === undefined) return "both";
  return pickEngine(args.engine, [args.paneId, args.tabId, args.workspaceId, args.sourcePaneId as string | undefined], env, args.host);
}

export function corePaneTool(bridge: BridgeDeps) {
  const { core } = bridge;
  const tool = "herdr_pane";
  return async (route: Exclude<Route, "herdr">, args: LayoutArgs, herdr: HerdrThunk<LayoutArgs>): Promise<ToolResult> => {
    const paneId = () => need(args.paneId, "paneId", tool, args.action);
    switch (args.action) {
      case "list": {
        if (route === "both") {
          const { rows, degraded } = await both(
            async () => tagged(await (await herdr()).client.paneList()),
            async () => onHost(await corePanes(core), args.host),
          );
          return withDegraded({ panes: rows, hint: PANE_HINT }, degraded);
        }
        return { panes: onHost(await corePanes(core, args.workspaceId), args.host), hint: PANE_HINT };
      }
      case "get":
        return { pane: await corePane(core, paneId()) };
      case "run": {
        const pane = await corePane(core, paneId());
        const sent = await core.terminalSend(pane.terminal, need(args.command as string | undefined, "command", tool, "run"));
        return ok(`command typed and entered in ${pane.terminal}; herdr_agent{action:'read',target:"${pane.terminal}"} to see output`, { sent });
      }
      case "close":
        await core.appDo("pane.close", { pane: paneId() });
        return ok("pane closed (its terminal ended)");
      case "focus":
        if (args.paneId) await core.appDo("pane.focus", { pane: args.paneId });
        if (args.direction) await core.appDo("pane.go", { direction: args.direction });
        if (!args.paneId && !args.direction) throw new Error(`${tool}{action:"focus"} requires "paneId" or "direction"`);
        return ok("focus moved");
      case "split": {
        const direction = need(args.splitDirection as string | undefined, "splitDirection", tool, "split");
        rejectFields(args, [["env", isSet], ["ratio", isSet], ["focus", isFalse]], tool, "split");
        if (args.cwd) {
          // pane.split has no folder; terminal.open does, beside the FOCUSED pane - so focus first.
          if (args.paneId) await core.appDo("pane.focus", { pane: args.paneId });
          const reply = await core.appDo("terminal.open", { folder: args.cwd, place: direction });
          return ok("pane split; herdr_pane{action:'list'} to see it", { ...reply });
        }
        const reply = await core.appDo("pane.split", { direction, ...(args.paneId ? { pane: args.paneId } : {}) });
        return ok("pane split; herdr_pane{action:'list'} to see it", { ...reply });
      }
      case "swap": {
        if (args.sourcePaneId || args.targetPaneId) {
          throw unsupported(tool, "swap", "the Herdr app swaps by direction only: pass direction (and paneId to anchor it)");
        }
        const direction = need(args.direction as string | undefined, "direction", tool, "swap");
        if (args.paneId) await core.appDo("pane.focus", { pane: args.paneId });
        await core.appDo("pane.swap", { direction });
        return ok("panes swapped");
      }
      case "rename":
        throw unsupported(tool, "rename", "Herdr app panes take their terminal's name; rename the tab instead (herdr_tab{action:'rename'})");
      case "move":
        throw unsupported(tool, "move", "close it and open a new one where you want it");
      default:
        throw unsupported(tool, args.action, "see this tool's description");
    }
  };
}

const PANE_HINT = "a pane with agent:'' is a plain shell, not an agent; engine says which engine runs it";

// --- herdr_tab ----------------------------------------------------------------

export function coreTabTool(bridge: BridgeDeps) {
  const { core } = bridge;
  const tool = "herdr_tab";
  return async (route: Exclude<Route, "herdr">, args: LayoutArgs, herdr: HerdrThunk<LayoutArgs>): Promise<ToolResult> => {
    const tabId = () => need(args.tabId, "tabId", tool, args.action);
    switch (args.action) {
      case "list": {
        if (route === "both") {
          const { rows, degraded } = await both(
            async () => tagged(await (await herdr()).client.tabList()),
            async () => onHost(await coreTabs(core), args.host),
          );
          return withDegraded({ tabs: rows }, degraded);
        }
        return { tabs: onHost(await coreTabs(core, args.workspaceId), args.host) };
      }
      case "get":
        return { tab: await coreTab(core, tabId()) };
      case "create": {
        rejectFields(args, [["focus", isFalse]], tool, "create");
        const reply = await core.appDo("tab.new", {
          ...(args.workspaceId ? { space: args.workspaceId } : {}),
          ...(args.cwd ? { folder: args.cwd } : {}),
          ...(args.label ? { name: args.label } : {}),
        });
        return ok("tab created and shown; herdr_tab{action:'list'} to see it", { ...reply });
      }
      case "rename":
        await core.appDo("tab.rename", { id: tabId(), name: need(args.label as string | undefined, "label", tool, "rename") });
        return ok("tab renamed; this changes the `<space>:<tab>` handle it answers to");
      case "focus":
        await core.appDo("tab.select", { id: tabId() });
        return ok("tab shown");
      case "close":
        await core.appDo("tab.close", { id: tabId(), confirmed: true });
        return ok("tab closed (its terminals ended)");
      default:
        throw unsupported(tool, args.action, "see this tool's description");
    }
  };
}

// --- herdr_workspace (Herdr app: spaces) --------------------------------------

export function coreWorkspaceTool(bridge: BridgeDeps) {
  const { core } = bridge;
  const tool = "herdr_workspace";
  return async (route: Exclude<Route, "herdr">, args: LayoutArgs, herdr: HerdrThunk<LayoutArgs>): Promise<ToolResult> => {
    const id = () => need(args.workspaceId, "workspaceId", tool, args.action);
    switch (args.action) {
      case "list": {
        if (route === "both") {
          const { rows, degraded } = await both(
            async () => tagged(await (await herdr()).client.workspaceList()),
            () => coreSpaces(core, args.host),
          );
          return withDegraded({ workspaces: rows }, degraded);
        }
        return { workspaces: await coreSpaces(core, args.host) };
      }
      case "get":
        return { workspace: await coreSpace(core, id()) };
      case "create": {
        rejectFields(args, [["focus", isFalse]], tool, "create");
        const host = args.host && args.host !== "local" ? args.host : undefined;
        const reply = await core.appDo("space.new", {
          folder: need(args.cwd as string | undefined, "cwd", tool, "create"),
          ...(args.label ? { name: args.label } : {}),
          ...(host ? { machine: host } : { machine: "" }),
        });
        return ok("space created and shown in the Herdr app; herdr_workspace{action:'list'} to see it", { ...reply });
      }
      case "rename":
        await core.appDo("space.rename", { id: id(), name: need(args.label as string | undefined, "label", tool, "rename") });
        return ok("space renamed; its name is the `<space>` half of a handle");
      case "focus":
        await core.appDo("space.select", { id: id() });
        return ok("space shown");
      case "close":
        await core.appDo("space.close", { id: id(), confirmed: true });
        return ok("space closed (its terminals ended)");
      default:
        throw unsupported(tool, args.action, "see this tool's description");
    }
  };
}
