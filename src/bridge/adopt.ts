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
  const argv = ["claude", "--resume", agent.sessionId];
  const reply = options.workspaceId
    ? await core.appDo("tab.new", { space: options.workspaceId, folder: agent.cwd, argv, ...(label ? { name: label } : {}) })
    : await core.appDo("space.new", { folder: agent.cwd, argv, machine: "", ...(label ? { name: label } : {}) });
  const terminal = replyId(reply, "terminal");
  if (terminal === null) {
    throw new BridgeError(
      "adopt_failed",
      `the Herdr app did not report the new terminal (reply: ${JSON.stringify(reply)}); the herdr pane ${agent.paneId} was left open`,
    );
  }

  // 3. Wait for it to come up: a status report plus a Claude session.
  const deadline = now() + readyTimeoutMs;
  let resumed: string | null = null;
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
    try {
      await core.appDo("terminal.kill", { terminal });
    } catch {
      // best effort: it may already be gone
    }
    throw new BridgeError(
      "adopt_failed",
      `the resumed session in Herdr app terminal ${terminal} did not come up (${lastSeen}); it was closed and the herdr pane ${agent.paneId} was left as it was`,
    );
  }

  // 4. Only now close the old pane - unless someone set it working meanwhile,
  // in which case the new one goes and the old one keeps its turn.
  const before = await herdr.agentGet(agent.paneId).catch(() => null);
  if (before !== null && before.sessionId === agent.sessionId && !AT_REST.has(before.status)) {
    await core.appDo("terminal.kill", { terminal }).catch(() => undefined);
    throw new BridgeError(
      "agent_busy",
      `herdr agent ${agent.paneId} started ${before.status} while the session was being resumed; the new Herdr app terminal ${terminal} was closed and the herdr pane left running`,
    );
  }
  await herdr.paneClose(agent.paneId);

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
