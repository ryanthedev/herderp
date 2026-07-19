// HerdrClient: the one deep module hiding herdr CLI shell-out, JSON parsing,
// and error normalization behind 9 typed methods. See the design comparison
// in the phase-2 discovery doc for why this shape (a shared private executor
// + thin typed methods) won over per-method spawn/parse duplication and a
// fully declarative command table.
//
// Every failure path - a herdr binary that never starts, a nonzero exit
// (JSON-shaped or plain-text), stdout that isn't parseable JSON, or a timed-
// out `agent wait` - normalizes to a HerdrError. No method ever throws a raw
// string or lets a herdr stdout blob escape uninterpreted.

import type {
  Agent,
  AgentReadOptions,
  AgentStatus,
  AgentWaitOptions,
  Pane,
  Session,
  Tab,
  Workspace,
  WorkspaceCreateOptions,
} from "./types.js";
import { HerdrError } from "./types.js";

/** What running one `herdr <argv...>` invocation produces. Swappable for
 * tests - production code never has to touch this shape directly. */
export interface HerdrRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** The process boundary HerdrClient depends on. Defaults to a real
 * `Bun.spawn`-backed runner; tests inject a stub and assert on the argv
 * they receive - no real herdr process, no mocking library. */
export type HerdrRunner = (argv: string[]) => Promise<HerdrRunResult>;

export interface HerdrClient {
  agentList(): Promise<Agent[]>;
  agentGet(target: string): Promise<Agent>;
  agentRead(target: string, opts?: AgentReadOptions): Promise<string>;
  agentWait(target: string, opts: AgentWaitOptions): Promise<Agent>;
  workspaceList(): Promise<Workspace[]>;
  /** Returns the created workspace plus its root pane's id (from the create
   * envelope's `result.root_pane.pane_id`) - the pane callers run commands
   * in. Phase 3-sanctioned seam addendum; see the phase-3 discovery doc
   * (GAP-1). */
  workspaceCreate(opts: WorkspaceCreateOptions): Promise<Workspace & { rootPaneId: string }>;
  workspaceFocus(id: string): Promise<void>;
  paneRun(paneId: string, command: string): Promise<void>;
  paneClose(paneId: string): Promise<void>;
  sessionList(): Promise<Session[]>;
  /** Lists tabs, all workspaces at once (bare) or scoped to one via
   * `--workspace`. One spawn regardless - used to turn a `<workspace>:<tab>`
   * handle into a tab id and to enrich live sessions with their handle. */
  tabList(workspaceId?: string): Promise<Tab[]>;
  /** Lists panes, all workspaces at once (bare) or scoped to one via
   * `--workspace`. Tolerant mapping: shell/non-claude panes come back with
   * empty agent/sessionId rather than throwing. */
  paneList(workspaceId?: string): Promise<Pane[]>;
}

/** Real process runner - the only place that touches `Bun.spawn`. */
async function bunHerdrRunner(argv: string[]): Promise<HerdrRunResult> {
  const proc = Bun.spawn(["herdr", ...argv], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isErrorEnvelope(value: unknown): value is { error: { code: string; message: string } } {
  return (
    isRecord(value) &&
    isRecord(value.error) &&
    typeof value.error.code === "string" &&
    typeof value.error.message === "string"
  );
}

/** Spawns one herdr invocation, normalizing a runner that never starts to a
 * typed `HerdrError` - shared by both `runHerdr` and `runHerdrVoid`. */
async function spawnHerdr(runner: HerdrRunner, argv: string[]): Promise<HerdrRunResult> {
  try {
    return await runner(argv);
  } catch (cause) {
    throw new HerdrError(
      "spawn_failed",
      `failed to launch herdr ${argv.join(" ")}: ${errorMessage(cause)}`,
      { cause },
    );
  }
}

/** Throws a typed HerdrError for a nonzero exit (JSON `{"error":...}` body,
 * verbatim; otherwise stderr/stdout text); no-op on exit 0. Shared so both
 * `runHerdr` and `runHerdrVoid` normalize command failure identically. */
function throwOnNonZeroExit(outcome: HerdrRunResult, argv: string[]): void {
  const { stdout, stderr, exitCode } = outcome;
  if (exitCode === 0) return;
  const trimmedStdout = stdout.trim();
  const parsed = trimmedStdout ? tryParseJson(trimmedStdout) : undefined;
  if (isErrorEnvelope(parsed)) {
    throw new HerdrError(parsed.error.code, parsed.error.message);
  }
  const detail = stderr.trim() || trimmedStdout || `herdr exited with code ${exitCode}`;
  throw new HerdrError("command_failed", `herdr ${argv.join(" ")}: ${detail}`);
}

/**
 * Runs one herdr invocation and returns its parsed JSON body, or throws a
 * HerdrError. Centralizes every failure mode so it's implemented (and
 * tested) once instead of once per public method:
 *   - the runner itself throwing (herdr never started)              -> "spawn_failed"
 *   - nonzero exit with a JSON `{"error":{code,message}}` body       -> that code, verbatim
 *   - nonzero exit with anything else (usage text, plain messages)   -> "command_failed"
 *   - exit 0 but stdout isn't parseable JSON (malformed/partial)     -> "invalid_response"
 */
async function runHerdr(runner: HerdrRunner, argv: string[]): Promise<unknown> {
  const outcome = await spawnHerdr(runner, argv);
  throwOnNonZeroExit(outcome, argv);

  const trimmedStdout = outcome.stdout.trim();
  const parsed = trimmedStdout ? tryParseJson(trimmedStdout) : undefined;
  if (parsed === undefined) {
    throw new HerdrError(
      "invalid_response",
      `herdr ${argv.join(" ")} produced no parseable JSON output: ${JSON.stringify(trimmedStdout.slice(0, 200))}`,
    );
  }
  return parsed;
}

/**
 * Like `runHerdr` but for commands that print nothing on success - verified
 * live: `herdr pane run <pane> <command>` types the command into the pane
 * (Enter included) and exits 0 with empty stdout, unlike every other
 * subcommand (`pane close`, `workspace focus`, ...) which echoes a
 * `{id,result}`/`{id,error}` JSON envelope either way. Failure handling is
 * identical to `runHerdr`; success never requires - or gets - parsed JSON.
 */
async function runHerdrVoid(runner: HerdrRunner, argv: string[]): Promise<void> {
  const outcome = await spawnHerdr(runner, argv);
  throwOnNonZeroExit(outcome, argv);
}

/** Reads `.result.<key>` out of the `{id,result:{...}}` envelope used by
 * agent/workspace/pane subcommands, validating the key is present. */
function unwrapResult(parsed: unknown, key: string, argv: string[]): unknown {
  if (!isRecord(parsed) || !isRecord(parsed.result) || !(key in parsed.result)) {
    throw new HerdrError(
      "invalid_response",
      `herdr ${argv.join(" ")}: expected result.${key} in response, got ${JSON.stringify(parsed).slice(0, 200)}`,
    );
  }
  return parsed.result[key];
}

const KNOWN_STATUSES: ReadonlySet<string> = new Set(["idle", "working", "blocked", "done", "unknown"]);

function toAgentStatus(raw: unknown): AgentStatus {
  return typeof raw === "string" && KNOWN_STATUSES.has(raw) ? (raw as AgentStatus) : "unknown";
}

function mapAgent(raw: unknown, argv: string[]): Agent {
  if (!isRecord(raw)) {
    throw new HerdrError("invalid_response", `herdr ${argv.join(" ")}: expected an agent object, got ${JSON.stringify(raw)}`);
  }
  const session = isRecord(raw.agent_session) ? raw.agent_session : undefined;
  const sessionId = typeof session?.value === "string" ? session.value : "";
  const required = ["agent", "cwd", "workspace_id", "tab_id", "pane_id"] as const;
  for (const field of required) {
    if (typeof raw[field] !== "string") {
      throw new HerdrError(
        "invalid_response",
        `herdr ${argv.join(" ")}: agent object missing string field "${field}": ${JSON.stringify(raw).slice(0, 200)}`,
      );
    }
  }
  return {
    agent: raw.agent as string,
    sessionId,
    status: toAgentStatus(raw.agent_status),
    cwd: raw.cwd as string,
    workspaceId: raw.workspace_id as string,
    tabId: raw.tab_id as string,
    paneId: raw.pane_id as string,
  };
}

function mapWorkspaceFields(raw: unknown, argv: string[]): Omit<Workspace, "cwd"> {
  if (!isRecord(raw) || typeof raw.workspace_id !== "string") {
    throw new HerdrError(
      "invalid_response",
      `herdr ${argv.join(" ")}: expected a workspace object, got ${JSON.stringify(raw).slice(0, 200)}`,
    );
  }
  return {
    id: raw.workspace_id,
    label: typeof raw.label === "string" ? raw.label : null,
    tabCount: typeof raw.tab_count === "number" ? raw.tab_count : 0,
    paneCount: typeof raw.pane_count === "number" ? raw.pane_count : 0,
  };
}

/** Maps one raw `tab list` entry. Requires the structural ids as strings
 * (a malformed shape is a herdr protocol break, kept loud); tolerates a
 * missing/null label and a non-number `number` (defaults to 0). */
function mapTab(raw: unknown, argv: string[]): Tab {
  if (!isRecord(raw) || typeof raw.tab_id !== "string" || typeof raw.workspace_id !== "string") {
    throw new HerdrError(
      "invalid_response",
      `herdr ${argv.join(" ")}: expected a tab object with string tab_id/workspace_id, got ${JSON.stringify(raw).slice(0, 200)}`,
    );
  }
  return {
    id: raw.tab_id,
    workspaceId: raw.workspace_id,
    label: typeof raw.label === "string" ? raw.label : null,
    number: typeof raw.number === "number" ? raw.number : 0,
    focused: raw.focused === true,
  };
}

/** Maps one raw `pane list` entry tolerantly: a pane without an agent (a
 * plain shell) or without an agent_session yields empty agent/sessionId
 * rather than throwing, so a mixed workspace never crashes the list. Only
 * the structural pane/workspace/tab ids must be strings. */
function mapPane(raw: unknown, argv: string[]): Pane {
  if (
    !isRecord(raw) ||
    typeof raw.pane_id !== "string" ||
    typeof raw.workspace_id !== "string" ||
    typeof raw.tab_id !== "string"
  ) {
    throw new HerdrError(
      "invalid_response",
      `herdr ${argv.join(" ")}: expected a pane object with string pane_id/workspace_id/tab_id, got ${JSON.stringify(raw).slice(0, 200)}`,
    );
  }
  const session = isRecord(raw.agent_session) ? raw.agent_session : undefined;
  return {
    id: raw.pane_id,
    workspaceId: raw.workspace_id,
    tabId: raw.tab_id,
    agent: typeof raw.agent === "string" ? raw.agent : "",
    sessionId: typeof session?.value === "string" ? session.value : "",
    cwd: typeof raw.cwd === "string" ? raw.cwd : "",
    status: toAgentStatus(raw.agent_status),
  };
}

function agentReadFlags(opts?: AgentReadOptions): string[] {
  if (!opts) return [];
  const flags: string[] = [];
  if (opts.source) flags.push("--source", opts.source);
  if (opts.lines !== undefined) flags.push("--lines", String(opts.lines));
  if (opts.format) flags.push("--format", opts.format);
  if (opts.ansi) flags.push("--ansi");
  return flags;
}

/**
 * Builds the HerdrClient. `runner` defaults to spawning the real `herdr`
 * binary; tests inject a stub matching argv to canned {stdout,stderr,
 * exitCode} responses - see test/herdr/client.test.ts.
 */
export function createHerdrClient(runner: HerdrRunner = bunHerdrRunner): HerdrClient {
  return {
    async agentList() {
      const argv = ["agent", "list"];
      const parsed = await runHerdr(runner, argv);
      const agents = unwrapResult(parsed, "agents", argv);
      if (!Array.isArray(agents)) {
        throw new HerdrError("invalid_response", `herdr ${argv.join(" ")}: expected result.agents to be an array`);
      }
      return agents.map((raw) => mapAgent(raw, argv));
    },

    async agentGet(target) {
      const argv = ["agent", "get", target];
      const parsed = await runHerdr(runner, argv);
      return mapAgent(unwrapResult(parsed, "agent", argv), argv);
    },

    async agentRead(target, opts) {
      const argv = ["agent", "read", target, ...agentReadFlags(opts)];
      const parsed = await runHerdr(runner, argv);
      const read = unwrapResult(parsed, "read", argv);
      if (!isRecord(read) || typeof read.text !== "string") {
        throw new HerdrError("invalid_response", `herdr ${argv.join(" ")}: expected result.read.text to be a string`);
      }
      return read.text;
    },

    async agentWait(target, { status, timeoutMs }) {
      const argv = [
        "agent",
        "wait",
        target,
        "--status",
        status,
        ...(timeoutMs !== undefined ? ["--timeout", String(timeoutMs)] : []),
      ];
      try {
        const parsed = await runHerdr(runner, argv);
        return mapAgent(unwrapResult(parsed, "agent", argv), argv);
      } catch (error) {
        if (
          error instanceof HerdrError &&
          error.code === "command_failed" &&
          /timed out/i.test(error.message)
        ) {
          throw new HerdrError("wait_timeout", error.message);
        }
        throw error;
      }
    },

    async workspaceList() {
      const argv = ["workspace", "list"];
      const parsed = await runHerdr(runner, argv);
      const workspaces = unwrapResult(parsed, "workspaces", argv);
      if (!Array.isArray(workspaces)) {
        throw new HerdrError("invalid_response", `herdr ${argv.join(" ")}: expected result.workspaces to be an array`);
      }
      return Promise.all(
        workspaces.map(async (raw) => {
          const fields = mapWorkspaceFields(raw, argv);
          const cwd = await firstPaneCwd(runner, fields.id);
          return { ...fields, cwd };
        }),
      );
    },

    async workspaceCreate(opts) {
      const argv = [
        "workspace",
        "create",
        "--cwd",
        opts.cwd,
        ...(opts.label !== undefined ? ["--label", opts.label] : []),
        ...(opts.focus !== undefined ? [opts.focus ? "--focus" : "--no-focus"] : []),
      ];
      const parsed = await runHerdr(runner, argv);
      const fields = mapWorkspaceFields(unwrapResult(parsed, "workspace", argv), argv);
      const rootPane = unwrapResult(parsed, "root_pane", argv);
      if (!isRecord(rootPane) || typeof rootPane.pane_id !== "string") {
        throw new HerdrError(
          "invalid_response",
          `herdr ${argv.join(" ")}: expected result.root_pane.pane_id to be a string, got ${JSON.stringify(rootPane).slice(0, 200)}`,
        );
      }
      // workspaceCreate always knows the cwd it asked for - no extra pane
      // query needed (unlike workspaceList, which has to infer it after the
      // fact from an existing workspace's first pane).
      return { ...fields, cwd: opts.cwd, rootPaneId: rootPane.pane_id };
    },

    async workspaceFocus(id) {
      await runHerdr(runner, ["workspace", "focus", id]);
    },

    async paneRun(paneId, command) {
      await runHerdrVoid(runner, ["pane", "run", paneId, command]);
    },

    async paneClose(paneId) {
      await runHerdr(runner, ["pane", "close", paneId]);
    },

    async sessionList() {
      const argv = ["session", "list", "--json"];
      const parsed = await runHerdr(runner, argv);
      if (!isRecord(parsed) || !Array.isArray(parsed.sessions)) {
        throw new HerdrError("invalid_response", `herdr ${argv.join(" ")}: expected a bare {sessions:[...]} body`);
      }
      return parsed.sessions.map((raw, index) => {
        if (
          !isRecord(raw) ||
          typeof raw.name !== "string" ||
          typeof raw.default !== "boolean" ||
          typeof raw.running !== "boolean"
        ) {
          throw new HerdrError(
            "invalid_response",
            `herdr ${argv.join(" ")}: sessions[${index}] missing name/default/running: ${JSON.stringify(raw)}`,
          );
        }
        return { name: raw.name, default: raw.default, running: raw.running };
      });
    },

    async tabList(workspaceId) {
      const argv = ["tab", "list", ...(workspaceId !== undefined ? ["--workspace", workspaceId] : [])];
      const parsed = await runHerdr(runner, argv);
      const tabs = unwrapResult(parsed, "tabs", argv);
      if (!Array.isArray(tabs)) {
        throw new HerdrError("invalid_response", `herdr ${argv.join(" ")}: expected result.tabs to be an array`);
      }
      return tabs.map((raw) => mapTab(raw, argv));
    },

    async paneList(workspaceId) {
      const argv = ["pane", "list", ...(workspaceId !== undefined ? ["--workspace", workspaceId] : [])];
      const parsed = await runHerdr(runner, argv);
      const panes = unwrapResult(parsed, "panes", argv);
      if (!Array.isArray(panes)) {
        throw new HerdrError("invalid_response", `herdr ${argv.join(" ")}: expected result.panes to be an array`);
      }
      return panes.map((raw) => mapPane(raw, argv));
    },
  };
}

/**
 * herdr 0.7.1's `workspace list`/`workspace get` do not expose an
 * identity_cwd field (verified live against a running herdr) - the closest
 * available signal is the workspace's first pane's cwd. Falls back to ""
 * (documented, not a crash) if a workspace has no panes, which should not
 * happen in practice but must not break workspaceList() if it does.
 */
async function firstPaneCwd(runner: HerdrRunner, workspaceId: string): Promise<string> {
  const argv = ["pane", "list", "--workspace", workspaceId];
  const parsed = await runHerdr(runner, argv);
  const panes = unwrapResult(parsed, "panes", argv);
  if (!Array.isArray(panes) || panes.length === 0) return "";
  const first = panes[0];
  return isRecord(first) && typeof first.cwd === "string" ? first.cwd : "";
}
