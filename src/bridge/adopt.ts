// adopt.ts: move a Claude Code session from a herdr pane into the Herdr app.
//
// The session's transcript is the session, so "moving" it is: resume it in a
// new Herdr app terminal (`claude --resume <id>`), then close the herdr pane.
// Two live Claude processes on one transcript is unsafe, so (decided
// 2026-11-08):
//   - refuse unless the herdr agent is idle or done: working is mid-turn,
//     blocked is waiting on someone, unknown might be either;
//   - close the old pane only once the new terminal is up: it reports a
//     status AND its Claude session file names a session;
//   - if the new one doesn't come up in time, close the NEW one and leave the
//     old pane exactly as it was.
//
// The new terminal starts through the window (`herdr-app do tab.new` /
// `space.new` with argv), which runs argv in the user's login shell - so a
// `claude` alias or wrapper with the user's usual flags applies.

import type { CoreClient } from "../core/client.js";
import type { SessionLookup } from "../core/sessions.js";
import { CoreError } from "../core/types.js";
import type { HerdrClient } from "../herdr/client.js";
import { replyId } from "../tools/core.js";
import { BridgeError } from "./resolve.js";
import { cleanLaunch } from "./cleanenv.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_READY_TIMEOUT_MS = 90_000;
const DEFAULT_READY_POLL_MS = 1_000;

export interface AdoptOptions {
  /** The herdr agent: a pane id or agent name. */
  target: string;
  /** A Herdr app space to add it to as a tab. Omitted: a new space. */
  workspaceId?: string;
  /** The new space's or tab's name. Default: the herdr workspace's label. */
  label?: string;
}

export interface AdoptDeps {
  herdr: HerdrClient;
  core: CoreClient;
  sessions: SessionLookup;
  /** How long the new terminal gets to come up. */
  readyTimeoutMs?: number;
  readyPollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface AdoptResult {
  ok: true;
  sessionId: string;
  /** The session the new terminal reports; normally the same id. */
  resumedSessionId: string;
  from: { engine: "herdr"; paneId: string; workspaceId: string };
  to: { engine: "core"; terminal: string; pane: string | null; workspaceId: string | null; tabId: string | null };
  hint: string;
}

/** Statuses at which a Claude session is safe to hand over: it is not mid-turn or waiting on a prompt.
 * "unknown" is not one - herdr couldn't tell, so it might be working. */
const AT_REST: ReadonlySet<string> = new Set(["idle", "done"]);

function assertAtRest(status: string, target: string, paneId: string): void {
  if (AT_REST.has(status)) return;
  throw new BridgeError(
    "agent_busy",
    `herdr agent ${target} (${paneId}) is ${status} - adopt it once it is idle or done (herdr_agent{action:'wait',target:"${paneId}"}); two live Claude processes must not share one session`,
  );
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? `[${code}] ${error.message}` : error.message;
  }
  return String(error);
}

/** A live terminal running `claude --resume <sessionId>`, if any. */
async function findResuming(core: CoreClient, sessionId: string): Promise<string | null> {
  try {
    const { terminals } = await core.terminalList();
    const hit = terminals.find((t) => t.state === "live" && (t.foreground?.argv.includes(sessionId) ?? false));
    return hit?.address ?? null;
  } catch {
    return null;
  }
}

/** The terminal a new tab holds, when a reply named the tab but not the terminal. */
async function findTerminal(core: CoreClient, reply: Record<string, unknown>): Promise<string | null> {
  const tabId = replyId(reply, "tab");
  if (tabId === null) return null;
  try {
    for (const space of await core.appSpaces()) {
      const tab = space.tabs.find((t) => t.id === tabId);
      if (tab && tab.terminals.length === 1) return tab.terminals[0]!.terminal;
    }
  } catch {
    // fall through: report what is known
  }
  return null;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function adoptAgent(options: AdoptOptions, deps: AdoptDeps): Promise<AdoptResult> {
  const { herdr, core, sessions } = deps;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const readyTimeoutMs = deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const readyPollMs = deps.readyPollMs ?? DEFAULT_READY_POLL_MS;

  // 1. The source: a Claude session in herdr, at rest.
  const agent = await herdr.agentGet(options.target);
  if (agent.agent !== "claude" || !UUID_RE.test(agent.sessionId)) {
    throw new BridgeError(
      "not_a_claude_session",
      `herdr agent ${options.target} (${agent.paneId}) is "${agent.agent || "no agent"}" with no Claude session id - only Claude Code sessions can be adopted`,
    );
  }
  assertAtRest(agent.status, options.target, agent.paneId);
  let label = options.label;
  if (label === undefined && options.workspaceId === undefined) {
    try {
      label = (await herdr.workspaceGet(agent.workspaceId)).label ?? undefined;
    } catch {
      label = undefined; // the window names an unnamed space after its folder
    }
  }

  // 2. The destination: a new tab in a given space, or a new space.
  // Clean of other sessions' markers, or the resumed Claude would stop saving its transcript.
  const argv = cleanLaunch(["claude", "--resume", agent.sessionId]);
  let reply: Record<string, unknown>;
  try {
    reply = options.workspaceId
      ? await core.appDo("tab.new", { space: options.workspaceId, folder: agent.cwd, argv, ...(label ? { name: label } : {}) })
      : await core.appDo("space.new", { folder: agent.cwd, argv, machine: "", ...(label ? { name: label } : {}) });
  } catch (error) {
    // The window may have started it anyway (a timeout kills only the CLI):
    // find any terminal resuming this session and close it.
    const stray = await findResuming(core, agent.sessionId);
    let outcome = `nothing resuming the session was found yet, but the window may still start one - if \`claude --resume ${agent.sessionId}\` may be running in the Herdr app, close one copy`;
    if (stray !== null) {
      try {
        await core.appDo("terminal.kill", { terminal: stray });
        outcome = `the resumed copy in ${stray} was closed`;
      } catch (killError) {
        outcome = `a resumed copy is running in ${stray} and could NOT be closed (${errorText(killError)}) - close it by hand`;
      }
    }
    throw new BridgeError(
      "adopt_failed",
      `the Herdr app did not confirm the new ${options.workspaceId ? "tab" : "space"} (${errorText(error)}); ${outcome}; the herdr pane ${agent.paneId} was left as it was`,
    );
  }
  const terminal = replyId(reply, "terminal") ?? (await findTerminal(core, reply));
  if (terminal === null) {
    const where = [replyId(reply, "space") && `space ${replyId(reply, "space")}`, replyId(reply, "tab") && `tab ${replyId(reply, "tab")}`]
      .filter(Boolean)
      .join(", ");
    throw new BridgeError(
      "adopt_failed",
      `the Herdr app did not report the new terminal (reply: ${JSON.stringify(reply)}). A \`claude --resume ${agent.sessionId}\` may be running${where ? ` in ${where}` : ""} - check it and close one copy; the herdr pane ${agent.paneId} was left open`,
    );
  }

  // From here until the old pane is closed, every way out closes the NEW
  // terminal, and says truthfully whether that worked.
  const closeNew = async (): Promise<string> => {
    try {
      await core.appDo("terminal.kill", { terminal });
      return `the new Herdr app terminal ${terminal} was closed`;
    } catch (error) {
      return `the new Herdr app terminal ${terminal} could NOT be closed (${errorText(error)}) - close it by hand, two Claude processes may share the session`;
    }
  };

  let resumed: string | null = null;
  try {
    // 3. Wait for it to come up: a status report plus a Claude session.
    const deadline = now() + readyTimeoutMs;
    let lastSeen = "no answer";
    for (;;) {
      try {
        const t = await core.terminalGet(terminal);
        if (t.state !== "live") {
          lastSeen = `its program ended (${t.state})`;
          break;
        }
        resumed = t.status !== null ? await sessions(t) : null;
        lastSeen = t.status === null ? "no status yet" : resumed === null ? `status ${t.status}, no session yet` : "up";
        if (resumed !== null) break;
      } catch (error) {
        if (!(error instanceof CoreError)) throw error;
        lastSeen = `[${error.code}] ${error.message}`;
        if (error.code === "not_found") break;
      }
      if (now() >= deadline) break;
      await sleep(readyPollMs);
    }
    if (resumed === null) {
      throw new BridgeError(
        "adopt_failed",
        `the resumed session in Herdr app terminal ${terminal} did not come up (${lastSeen}); ${await closeNew()}, and the herdr pane ${agent.paneId} was left as it was`,
      );
    }

    // 4. Close the old pane only if a fresh look proves it is still the same
    // Claude session, at rest. Anything else - busy, a different session
    // after /clear, a different program, or no answer - keeps the old pane.
    let before: Awaited<ReturnType<HerdrClient["agentGet"]>> | null = null;
    let recheck = "";
    try {
      before = await herdr.agentGet(agent.paneId);
    } catch (error) {
      recheck = errorText(error);
    }
    const unchanged = before !== null && before.agent === "claude" && before.sessionId === agent.sessionId && AT_REST.has(before.status);
    if (!unchanged) {
      const what =
        before === null
          ? `could not be checked again (${recheck})`
          : before.sessionId !== agent.sessionId || before.agent !== "claude"
            ? `now runs something else (${before.agent || "no agent"}, session ${before.sessionId || "none"})`
            : `started ${before.status}`;
      throw new BridgeError(
        "agent_busy",
        `herdr agent ${agent.paneId} ${what} while the session was being resumed; ${await closeNew()}, and the herdr pane was left running`,
      );
    }
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError("adopt_failed", `adopt failed while bringing up ${terminal} (${errorText(error)}); ${await closeNew()}, and the herdr pane ${agent.paneId} was left as it was`);
  }

  try {
    await herdr.paneClose(agent.paneId);
  } catch (error) {
    throw new BridgeError(
      "adopt_failed",
      `the session runs in Herdr app terminal ${terminal}, but closing the herdr pane ${agent.paneId} failed (${errorText(error)}): ${await closeNew()}; check the herdr pane before trying again`,
    );
  }

  const fresh = await core.terminalGet(terminal).catch(() => null);
  return {
    ok: true,
    sessionId: agent.sessionId,
    resumedSessionId: resumed,
    from: { engine: "herdr", paneId: agent.paneId, workspaceId: agent.workspaceId },
    to: {
      engine: "core",
      terminal,
      pane: replyId(reply, "pane"),
      workspaceId: replyId(reply, "space") ?? fresh?.spaceId ?? options.workspaceId ?? null,
      tabId: replyId(reply, "tab") ?? fresh?.tabId ?? null,
    },
    hint:
      resumed === agent.sessionId
        ? `adopted: the session now runs in Herdr app terminal ${terminal}; address it as target:"${terminal}"`
        : `adopted, but Claude reports session ${resumed} (resume may have forked it); address it as target:"${terminal}"`,
  };
}
