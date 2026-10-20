// run.ts: the I/O half of `herderp watch`. Resolves the targets through
// herdr, subscribes to their status events on herdr's socket, polls each
// agent's liveness and transcript, and prints the Watcher's events - one line
// each, flushed immediately, because the process runs under Claude Code's
// Monitor tool, where every stdout line becomes a notification.
//
// Activity signal: an agent's Claude Code transcript
// (~/.claude/projects/<slug>/<sessionId>.jsonl) is written within seconds of
// every step it takes, so its mtime is the heartbeat stall detection reads.
// The session id is re-read from herdr on every poll (it changes on /clear).
//
// Every way the watch can end prints a line first, so silence never looks
// like "still running": a target that won't resolve (exit 2), the event
// stream dropping (exit 1), every target gone or `once` satisfied (exit 0).

import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { HerdrClient } from "../herdr/client.js";
import { toAgentStatus } from "../herdr/client.js";
import { subscribeEvents, type EventStream, type HerdrEvent } from "../herdr/events.js";
import { HerdrError, type Agent } from "../herdr/types.js";
import { deriveSlug } from "../necromancy/core.js";
import {
  formatEvent,
  formatEventJson,
  STOPPED_STATUSES,
  Watcher,
  type EventContext,
  type WatchEvent,
} from "./watcher.js";

export interface RunWatchOptions {
  /** Agent names or pane ids, as herdr's `agent get` accepts them. */
  targets: string[];
  stallMs?: number;
  /** Exit after the first event. */
  once?: boolean;
  json?: boolean;
  verbose?: boolean;
}

export interface RunWatchDeps {
  client: HerdrClient;
  socketPath: string;
  /** Claude Code's session store (~/.claude/projects). */
  projectsRoot: string;
  /** Write one line (the caller adds nothing; this adds the newline). */
  write: (line: string) => void;
  /** The agent's last assistant text, for stop summaries. */
  readLastState: (sessionId: string, cwd: string) => Promise<string | undefined>;
  now?: () => number;
  /** Liveness/activity poll interval. Default 15s. */
  pollMs?: number;
  /** How long to let a stopped agent's transcript catch up before summarizing. Default 2.5s. */
  summaryDelayMs?: number;
}

const DEFAULT_POLL_MS = 15_000;
const DEFAULT_SUMMARY_DELAY_MS = 2_500;

function transcriptPath(projectsRoot: string, agent: Agent): string | null {
  if (agent.sessionId === "") return null;
  return join(projectsRoot, deriveSlug(agent.cwd), `${agent.sessionId}.jsonl`);
}

async function mtimeOf(path: string | null): Promise<number | null> {
  if (path === null) return null;
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Watch until done; resolves with the process exit code. */
export async function runWatch(options: RunWatchOptions, deps: RunWatchDeps): Promise<number> {
  const { client, projectsRoot, write } = deps;
  const now = deps.now ?? Date.now;
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  const summaryDelayMs = deps.summaryDelayMs ?? DEFAULT_SUMMARY_DELAY_MS;

  // 1. Resolve every target up front; a typo fails fast, before anything is armed.
  const agents = new Map<string, { label: string; agent: Agent }>();
  for (const label of options.targets) {
    let agent: Agent;
    try {
      agent = await client.agentGet(label);
    } catch (error) {
      write(`[${label}] not found - ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
    if (!agents.has(agent.paneId)) agents.set(agent.paneId, { label, agent });
  }

  // 2. Say what is being watched, including targets that have already stopped:
  // no further event will come for those, so this line is the only notice.
  const startedAt = now();
  const targets = [];
  for (const [paneId, { label, agent }] of agents) {
    const hasTranscript = (await mtimeOf(transcriptPath(projectsRoot, agent))) !== null;
    const noStall = options.stallMs !== undefined && !hasTranscript;
    targets.push({ label, paneId, status: agent.status, noStall });
    const session = agent.sessionId ? ` (session ${agent.sessionId.slice(0, 8)})` : "";
    const note = noStall ? " - no transcript found, stall detection off" : "";
    write(`[${label}] watching - currently ${agent.status}${session}${note}`);
  }
  const watcher = new Watcher(targets, startedAt, { stallMs: options.stallMs, verbose: options.verbose });

  return await new Promise<number>((resolve) => {
    let stream: EventStream | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let finished = false;
    // Events print in arrival order even though stop summaries are async.
    let queue: Promise<void> = Promise.resolve();

    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      if (timer) clearInterval(timer);
      stream?.close();
      resolve(code);
    };

    const contextFor = async (event: WatchEvent): Promise<EventContext> => {
      if (event.type !== "status" || !STOPPED_STATUSES.has(event.status)) return {};
      await sleep(summaryDelayMs); // let the final turn reach the transcript
      try {
        const agent = await client.agentGet(event.paneId);
        if (agent.sessionId === "") return {};
        const lastState = await deps.readLastState(agent.sessionId, agent.cwd);
        return { sessionId: agent.sessionId, ...(lastState !== undefined && { lastState }) };
      } catch {
        return {}; // a summary is a bonus; the event still prints
      }
    };

    const emit = (events: WatchEvent[]) => {
      for (const event of events) {
        queue = queue.then(async () => {
          if (finished) return;
          const context = await contextFor(event);
          write(options.json ? formatEventJson(event, context) : formatEvent(event, context));
          if (options.once || watcher.allGone()) finish(0);
        });
      }
    };

    const onEvent = (event: HerdrEvent) => {
      if (event.event !== "pane.agent_status_changed") return;
      const paneId = event.data.pane_id;
      if (typeof paneId !== "string") return;
      // A null agent is the agent leaving the pane, not a status.
      if (event.data.agent === null) emit(watcher.gone(paneId, "agent exited"));
      else emit(watcher.status(paneId, toAgentStatus(event.data.agent_status), now()));
    };

    const poll = async () => {
      for (const paneId of watcher.livePaneIds()) {
        try {
          const agent = await client.agentGet(paneId);
          const at = await mtimeOf(transcriptPath(projectsRoot, agent));
          if (at !== null) watcher.activity(paneId, at);
        } catch (error) {
          if (error instanceof HerdrError && error.code === "agent_not_found") {
            emit(watcher.gone(paneId, "no longer running in herdr (pane closed or agent exited)"));
          }
          // any other failure is transient: the next poll tries again
        }
      }
      emit(watcher.tick(now()));
    };

    subscribeEvents({
      socketPath: deps.socketPath,
      subscriptions: watcher.livePaneIds().map((pane_id) => ({ type: "pane.agent_status_changed", pane_id })),
      onEvent,
      onClose: (reason) => {
        queue = queue.then(() => {
          if (finished) return;
          write(`[watch] lost herdr's event stream - ${reason}. Re-arm the watch once herdr is back.`);
          finish(1);
        });
      },
    }).then(
      (s) => {
        stream = s;
        if (finished) s.close();
        else timer = setInterval(() => void poll(), pollMs);
      },
      (error: unknown) => {
        write(`[watch] could not subscribe to herdr events - ${error instanceof Error ? error.message : String(error)}`);
        finish(1);
      },
    );
  });
}
