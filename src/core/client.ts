// CoreClient: the one module that talks to herdr-core (`hc`) and the Herdr
// desktop app's layout CLI (`herdr-app`). It hides the JSON-RPC transport,
// the raw terminal objects, and error normalization behind typed methods,
// the same way HerdrClient hides the `herdr` CLI.
//
// Transport: one short-lived `hc connect` per call. `hc connect` speaks
// JSON-RPC 2.0 as JSON lines on stdin/stdout. A fresh process per call
// sidesteps two traps of a shared connection (verified 2026-11-08): replies
// come back strictly in request order, so one slow call (a history read takes
// 1-12 s on an idle agent, a send waits ~3 s for quiet) holds up everything
// behind it; and closing stdin drops replies still in flight. So the process
// is ended only after the reply with our id has arrived.
//
// Layout (spaces, tabs, panes) belongs to the window, not the core:
// `herdr-app ls` and `herdr-app do <command> <json>` - both print JSON, and a
// failed command prints {"error": "..."} and exits 1.
//
// Every failure normalizes to a CoreError with a code: the RPC error's
// `data.kind` (e.g. `not_found`), else `core_unreachable`, `app_unreachable`,
// `app_error`, `bad_response`, or `timeout`.

import type {
  AppSpace,
  AppTab,
  AppTerminalRef,
  CoreInterruptResult,
  CoreListing,
  CoreMachine,
  CoreReadResult,
  CoreSendResult,
  CoreStatus,
  CoreTerminal,
  CoreWaitResult,
} from "./types.js";
import { CoreError } from "./types.js";

/** One JSON-RPC call to herdr-core. Swappable for tests. Resolves with the
 * `result`, rejects with a CoreError. */
export type CoreRpc = (method: string, params: Record<string, unknown>, opts?: { timeoutMs?: number }) => Promise<unknown>;

export interface AppRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Runs `herdr-app <argv...>`. Swappable for tests. */
export type AppRunner = (argv: string[]) => Promise<AppRunResult>;

/** Most calls answer in well under a second; this only bounds a hung core. */
const DEFAULT_RPC_TIMEOUT_MS = 30_000;
/** hc's own default wait before a wait "checks in" (seconds). */
const HC_DEFAULT_WAIT_S = 180;
/** Slack on top of hc's own wait timeout before we give up on the process. */
const WAIT_SLACK_MS = 15_000;

export interface CoreClient {
  /** Every live terminal here and on connected machines (`machine/t7`). */
  terminalList(opts?: { all?: boolean; labels?: Record<string, string> }): Promise<CoreListing>;
  terminalGet(terminal: string): Promise<CoreTerminal>;
  /** `lines` of history above the screen; 0 (default) is the screen only - fast. */
  terminalRead(terminal: string, opts?: { lines?: number }): Promise<CoreReadResult>;
  /** Paste text and press Enter once nobody has typed for ~3 s. */
  terminalSend(terminal: string, text: string, opts?: { wait?: boolean; timeoutMs?: number; force?: boolean }): Promise<CoreSendResult>;
  /** Press named keys: enter, esc, tab, up, ctrl+c, ... */
  terminalKeys(terminal: string, keys: string[]): Promise<{ turn: number; status: string | null }>;
  /** Until it is not working (or exits). Times out as a check-in (`ended: false`). */
  terminalWait(terminal: string, opts?: { timeoutMs?: number }): Promise<CoreWaitResult>;
  /** The stop key (esc for agents), then what was observed. Never escalates. */
  terminalInterrupt(terminal: string): Promise<CoreInterruptResult>;
  /** Set labels; an empty value removes one. */
  terminalLabel(terminal: string, labels: Record<string, string>): Promise<CoreTerminal>;
  machineList(): Promise<CoreMachine[]>;

  /** The window's spaces > tabs > terminals. */
  appSpaces(): Promise<AppSpace[]>;
  /** One window command (`herdr-app commands` lists them); returns its JSON reply. */
  appDo(command: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

// --- transport ------------------------------------------------------------

/** Spawns one process with piped stdio. Injected so the transport itself is
 * testable against a fake `hc connect`. */
export type ConnectSpawn = (argv: string[]) => {
  stdin: { write(chunk: string): unknown; end(): unknown };
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
};

const bunSpawn: ConnectSpawn = (argv) => {
  const proc = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  return {
    stdin: { write: (chunk) => proc.stdin.write(chunk), end: () => proc.stdin.end() },
    stdout: proc.stdout,
    stderr: proc.stderr,
    exited: proc.exited,
    kill: () => proc.kill(),
  };
};

let nextId = 1;

/**
 * The real CoreRpc: one `hc connect` process per call. Lines that are not
 * our reply (heartbeats, events, other ids, non-JSON) are skipped.
 */
export function createConnectRpc(command: string[] = ["hc", "connect"], spawn: ConnectSpawn = bunSpawn): CoreRpc {
  return async (method, params, opts = {}) => {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    const id = nextId++;
    let proc: ReturnType<ConnectSpawn>;
    try {
      proc = spawn(command);
    } catch (cause) {
      if (isEnoent(cause)) throw new CoreError("not_installed", `\`${command[0]}\` is not installed here (herdr-core / the Herdr app)`, { cause });
      throw new CoreError("core_unreachable", `could not start \`${command.join(" ")}\`: ${errorMessage(cause)}`, { cause });
    }
    const stderrText = new Response(proc.stderr).text().catch(() => "");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      const reply = await Promise.race([
        readReply(proc.stdout, id),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new CoreError("timeout", `herdr-core did not answer ${method} within ${timeoutMs} ms`)),
            timeoutMs,
          );
        }),
      ]);
      if (reply === null) {
        const stderr = (await stderrText).trim();
        throw new CoreError(
          "core_unreachable",
          `herdr-core closed the connection before answering ${method}${stderr ? `: ${stderr}` : ""}`,
        );
      }
      return unwrapReply(reply, method);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      try {
        proc.stdin.end();
      } catch {
        // already closed
      }
      proc.kill();
    }
  };
}

/** Reads JSON lines until the reply with `id`; null if the stream ends first. */
async function readReply(stream: ReadableStream<Uint8Array>, id: number): Promise<Record<string, unknown> | null> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return null;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        const parsed = tryParseJson(line);
        if (isRecord(parsed) && parsed.id === id) return parsed;
        newline = buffer.indexOf("\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function unwrapReply(reply: Record<string, unknown>, method: string): unknown {
  if (isRecord(reply.error)) {
    const error = reply.error;
    const data = isRecord(error.data) ? error.data : {};
    const kind = typeof data.kind === "string" && data.kind !== "" ? data.kind : "rpc_error";
    const message = typeof error.message === "string" ? error.message : `${method} failed`;
    const hint = typeof data.hint === "string" ? ` (${data.hint})` : "";
    throw new CoreError(kind, `${message}${hint}`);
  }
  if (!("result" in reply)) throw new CoreError("bad_response", `${method}: reply has neither result nor error`);
  return reply.result;
}

/** A hung window must not hang every call behind it. */
const APP_TIMEOUT_MS = 15_000;

async function bunAppRunner(argv: string[]): Promise<AppRunResult> {
  const proc = Bun.spawn(["herdr-app", ...argv], { stdout: "pipe", stderr: "pipe" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]).then(
        ([stdout, stderr, exitCode]) => ({ stdout, stderr, exitCode }),
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          proc.kill();
          reject(new CoreError("timeout", `herdr-app ${argv[0]} did not answer within ${APP_TIMEOUT_MS / 1000}s`));
        }, APP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function isEnoent(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "ENOENT";
}

// --- mapping --------------------------------------------------------------

const CORE_STATUSES: ReadonlySet<string> = new Set(["idle", "working", "blocked", "done", "error"]);

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** `ska/t7` -> "ska"; `t7` -> null. */
export function machineOf(address: string): string | null {
  const slash = address.indexOf("/");
  return slash === -1 ? null : address.slice(0, slash);
}

export function toCoreTerminal(raw: unknown): CoreTerminal {
  if (!isRecord(raw) || typeof raw.address !== "string") {
    throw new CoreError("bad_response", "terminal object has no address");
  }
  const status = isRecord(raw.status) ? raw.status : null;
  const state = status ? str(status.state) : null;
  const labels: Record<string, string> = {};
  if (isRecord(raw.labels)) {
    for (const [key, value] of Object.entries(raw.labels)) if (typeof value === "string") labels[key] = value;
  }
  const fg = isRecord(raw.foreground) ? raw.foreground : null;
  const foreground =
    fg && num(fg.pid) !== null
      ? {
          pid: num(fg.pid)!,
          argv: Array.isArray(fg.argv) ? fg.argv.filter((a): a is string => typeof a === "string") : [],
          cwd: str(fg.cwd) ?? "",
        }
      : null;
  return {
    address: raw.address,
    name: str(raw.name),
    state: str(raw.state) ?? "live",
    app: (status && str(status.app)) ?? "",
    status: state !== null && CORE_STATUSES.has(state) ? (state as CoreStatus) : null,
    blockedKind: status ? str(status.kind) : null,
    message: (status && str(status.msg)) ?? "",
    title: (status && str(status.title)) || (str(raw.title) ?? ""),
    turn: num(raw.turn) ?? 0,
    cwd: foreground?.cwd || (str(raw.cwd) ?? ""),
    foreground,
    labels,
    parent: str(raw.parent),
    spaceId: labels["herdr.space"] ?? null,
    tabId: labels["herdr.tab"] ?? null,
    where: labels.where ?? null,
    machine: machineOf(raw.address),
  };
}

function toWaitResult(raw: unknown): CoreWaitResult {
  const r = isRecord(raw) ? raw : {};
  return {
    terminal: str(r.terminal) ?? "",
    ended: r.ended === true,
    reason: str(r.reason) ?? "",
    status: str(r.status),
    turn: num(r.turn) ?? 0,
    exitCode: num(r.exit_code),
  };
}

function toAppSpaces(raw: unknown): AppSpace[] {
  if (!isRecord(raw) || !Array.isArray(raw.spaces)) throw new CoreError("bad_response", "herdr-app ls: no spaces array");
  return raw.spaces.filter(isRecord).map((space) => ({
    id: str(space.id) ?? "",
    name: str(space.name) ?? "",
    folder: str(space.folder),
    machine: str(space.machine),
    active: space.active === true,
    tabs: (Array.isArray(space.tabs) ? space.tabs : []).filter(isRecord).map(
      (tab): AppTab => ({
        id: str(tab.id) ?? "",
        name: str(tab.name) ?? "",
        active: tab.active === true,
        terminals: (Array.isArray(tab.terminals) ? tab.terminals : []).filter(isRecord).map(
          (t): AppTerminalRef => ({
            terminal: str(t.terminal) ?? "",
            pane: str(t.pane) ?? "",
            status: str(t.status),
            app: str(t.app),
            name: str(t.name),
          }),
        ),
      }),
    ),
  }));
}

// --- client ---------------------------------------------------------------

export interface CoreClientDeps {
  rpc?: CoreRpc;
  app?: AppRunner;
}

export function createCoreClient(deps: CoreClientDeps = {}): CoreClient {
  const rpc = deps.rpc ?? createConnectRpc();
  const app = deps.app ?? bunAppRunner;

  async function runApp(argv: string[]): Promise<Record<string, unknown>> {
    let result: AppRunResult;
    try {
      result = await app(argv);
    } catch (cause) {
      if (cause instanceof CoreError) throw cause;
      if (isEnoent(cause)) throw new CoreError("not_installed", "`herdr-app` (the Herdr desktop app) is not installed here", { cause });
      throw new CoreError("app_unreachable", `could not run herdr-app: ${errorMessage(cause)}`, { cause });
    }
    const parsed = tryParseJson(result.stdout.trim());
    if (result.exitCode !== 0) {
      if (isRecord(parsed) && typeof parsed.error === "string") {
        throw new CoreError("app_error", `herdr-app ${argv.join(" ")}: ${parsed.error}`);
      }
      const detail = (result.stderr || result.stdout).trim() || `exit ${result.exitCode}`;
      throw new CoreError("app_unreachable", `herdr-app ${argv[0]} failed: ${detail}`);
    }
    if (!isRecord(parsed)) throw new CoreError("bad_response", `herdr-app ${argv[0]}: output is not a JSON object`);
    return parsed;
  }

  function waitBudget(timeoutMs: number | undefined): { seconds: number; processMs: number } {
    const seconds = timeoutMs !== undefined ? timeoutMs / 1000 : HC_DEFAULT_WAIT_S;
    return { seconds, processMs: seconds * 1000 + WAIT_SLACK_MS };
  }

  return {
    async terminalList(opts = {}) {
      const raw = await rpc("terminal.list", { all: opts.all ?? false, labels: opts.labels ?? {} });
      if (!isRecord(raw) || !Array.isArray(raw.terminals)) throw new CoreError("bad_response", "terminal.list: no terminals array");
      const machines = (Array.isArray(raw.machines) ? raw.machines : []).filter(isRecord).map((m) => ({
        name: str(m.name) ?? "",
        state: str(m.state) ?? "",
      }));
      return { terminals: raw.terminals.map(toCoreTerminal), machines };
    },
    async terminalGet(terminal) {
      return toCoreTerminal(await rpc("terminal.get", { terminal }));
    },
    async terminalRead(terminal, opts = {}) {
      const lines = opts.lines ?? 0;
      // History reads can take seconds on an idle agent; give them room.
      const raw = await rpc("terminal.read", { terminal, lines }, { timeoutMs: lines > 0 ? 60_000 : DEFAULT_RPC_TIMEOUT_MS });
      const r = isRecord(raw) ? raw : {};
      if (typeof r.text !== "string") throw new CoreError("bad_response", "terminal.read: no text");
      return { text: r.text, complete: r.complete !== false, how: str(r.how) ?? "", why: str(r.why) };
    },
    async terminalSend(terminal, text, opts = {}) {
      const params: Record<string, unknown> = { terminal, text };
      if (opts.force) params.force = true;
      let processMs = DEFAULT_RPC_TIMEOUT_MS;
      if (opts.wait) {
        const budget = waitBudget(opts.timeoutMs);
        params.wait = true;
        params.timeout = budget.seconds;
        processMs = budget.processMs;
      }
      const raw = await rpc("terminal.send", params, { timeoutMs: processMs });
      const r = isRecord(raw) ? raw : {};
      return {
        turn: num(r.turn) ?? 0,
        started: typeof r.started === "boolean" ? r.started : null,
        status: str(r.status),
        wait: isRecord(r.wait) ? toWaitResult(r.wait) : null,
      };
    },
    async terminalKeys(terminal, keys) {
      const raw = await rpc("terminal.keys", { terminal, keys });
      const r = isRecord(raw) ? raw : {};
      return { turn: num(r.turn) ?? 0, status: str(r.status) };
    },
    async terminalWait(terminal, opts = {}) {
      const budget = waitBudget(opts.timeoutMs);
      return toWaitResult(await rpc("terminal.wait", { terminal, timeout: budget.seconds }, { timeoutMs: budget.processMs }));
    },
    async terminalInterrupt(terminal) {
      const raw = await rpc("terminal.interrupt", { terminal }, { timeoutMs: 20_000 });
      const r = isRecord(raw) ? raw : {};
      return { outcome: str(r.outcome) ?? "unknown", key: str(r.key) ?? "" };
    },
    async terminalLabel(terminal, labels) {
      return toCoreTerminal(await rpc("terminal.label", { terminal, labels }));
    },
    async machineList() {
      const raw = await rpc("machine.list", {});
      const list = isRecord(raw) && Array.isArray(raw.machines) ? raw.machines : Array.isArray(raw) ? raw : [];
      return list.filter(isRecord).map((m) => ({ name: str(m.name) ?? "", state: str(m.state) ?? "" }));
    },
    async appSpaces() {
      return toAppSpaces(await runApp(["ls"]));
    },
    async appDo(command, args) {
      return runApp(["do", command, JSON.stringify(args)]);
    },
  };
}

// --- helpers --------------------------------------------------------------

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
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
