// run.ts: the I/O half of `herderp watch`. Resolves the targets through
// herdr, subscribes to their status events on herdr's socket, polls each
// agent's liveness, status, and transcript, and prints the Watcher's events -
// one line each, flushed immediately, because the process runs under Claude
// Code's Monitor tool, where every stdout line becomes a notification.
//
// Activity signal: an agent's Claude Code transcript
// (~/.claude/projects/<slug>/<sessionId>.jsonl) is written within seconds of
// every step it takes, so its mtime is the heartbeat stall detection reads.
// The session id is re-read from herdr on every poll (it changes on /clear).
//
// Status comes from two places. The socket is authoritative and immediate;
// polls reconcile anything it missed - a stop between the first lookup and
// the subscription, or a dropped event. A poll's answer is applied only if no
// socket event arrived for that pane while the poll was in flight, so a slow
// lookup can never overwrite a newer event.
//
// Every way the watch can end prints a line first, so silence never looks
// like "still running": a target that won't resolve (exit 2), the event
// stream dropping (exit 1), every target gone or `once` satisfied (exit 0).
// With `json`, every line - including those - is one JSON object.

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
  /** Liveness/status/activity poll interval. Default 15s. */
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
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Watch until done; resolves with the process exit code. */
export async function runWatch(options: RunWatchOptions, deps: RunWatchDeps): Promise<number> {
  const { client, projectsRoot } = deps;
  const now = deps.now ?? Date.now;
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  const summaryDelayMs = deps.summaryDelayMs ?? DEFAULT_SUMMARY_DELAY_MS;
  /** Print one line: the text form, or the JSON record in json mode. */
  const say = (text: string, record: Record<string, unknown>) =>
    deps.write(options.json ? JSON.stringify(record) : text);

  // 1. Resolve every target up front; a typo fails fast, before anything is armed.
  const agents = new Map<string, { label: string; agent: Agent }>();
  for (const label of options.targets) {
    let agent: Agent;
    try {
      agent = await client.agentGet(label);
    } catch (error) {
      say(`[${label}] not found - ${messageOf(error)}`, { type: "not_found", label, detail: messageOf(error) });
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
    const note = noStall ? " - no transcript yet, stall detection starts when one appears" : "";
    say(`[${label}] watching - currently ${agent.status}${session}${note}`, {
      type: "watching",
      label,
      paneId,
      status: agent.status,
      ...(agent.sessionId && { sessionId: agent.sessionId }),
      ...(options.stallMs !== undefined && { stallDetection: !noStall }),
    });
  }
  const watcher = new Watcher(targets, startedAt, { stallMs: options.stallMs, verbose: options.verbose });
  // The session each pane held at its last lookup. herdr's status events
  // carry no session id, so this is how a session switch is noticed.
  const knownSession = new Map([...agents].map(([paneId, { agent }]) => [paneId, agent.sessionId]));

  return await new Promise<number>((resolve) => {
    let stream: EventStream | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let finished = false;
    // Events print in arrival order even though stop summaries are async;
    // `pending` counts what is queued but not yet printed, so the watch never
    // exits with a notification still waiting (e.g. two departures at once).
    let queue: Promise<void> = Promise.resolve();
    let pending = 0;
    // Per-pane count of socket status events: a poll applies its status only
    // if this hasn't moved while it was in flight.
    const socketSeq = new Map<string, number>();

    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      if (timer) clearInterval(timer);
      stream?.close();
      resolve(code);
    };

    /**
     * A stop's summary. Started the moment the event is emitted - not when the
     * queue reaches it - so a /clear after the lookup can't swap the session
     * it quotes. herdr's stop event names no session, so the lookup must agree
     * with the session last seen in that pane; if the pane switched sessions
     * in between, which session stopped is uncertain and the line goes out
     * without a summary rather than with a possibly wrong one.
     */
    const contextFor = async (event: WatchEvent): Promise<EventContext> => {
      if (event.type !== "status" || !STOPPED_STATUSES.has(event.status)) return {};
      const expected = knownSession.get(event.paneId);
      let session: { sessionId: string; cwd: string };
      try {
        const agent = await client.agentGet(event.paneId);
        if (agent.sessionId === "" || agent.sessionId !== expected) return {};
        session = { sessionId: agent.sessionId, cwd: agent.cwd };
      } catch {
        return {}; // a summary is a bonus; the event still prints
      }
      await sleep(summaryDelayMs); // let the final turn reach that session's transcript
      try {
        const lastState = await deps.readLastState(session.sessionId, session.cwd);
        return { sessionId: session.sessionId, ...(lastState !== undefined && { lastState }) };
      } catch {
        return { sessionId: session.sessionId };
      }
    };

    const emit = (events: WatchEvent[]) => {
      for (const event of events) {
        pending += 1;
        const context = contextFor(event); // bind the session now; print in order below
        queue = queue.then(async () => {
          if (finished) return;
          const resolved = await context;
          if (finished) return;
          deps.write(options.json ? formatEventJson(event, resolved) : formatEvent(event, resolved));
          pending -= 1;
          if (options.once || (watcher.allGone() && pending === 0)) finish(0);
        });
      }
    };

    /** Queue a terminal line behind any pending notifications, then exit. */
    const fail = (text: string, record: Record<string, unknown>) => {
      queue = queue.then(() => {
        if (finished) return;
        say(text, record);
        finish(1);
      });
    };

    const onEvent = (event: HerdrEvent) => {
      if (event.event !== "pane.agent_status_changed") return;
      const paneId = event.data.pane_id;
      if (typeof paneId !== "string") return;
      socketSeq.set(paneId, (socketSeq.get(paneId) ?? 0) + 1);
      // A null agent is the agent leaving the pane, not a status.
      if (event.data.agent === null) emit(watcher.gone(paneId, "agent exited"));
      else emit(watcher.status(paneId, toAgentStatus(event.data.agent_status), now()));
    };

    // One poll at a time: a poll slower than pollMs must not overlap the next,
    // or an older answer could land after a newer one.
    let polling = false;
    const poll = async () => {
      if (polling || finished) return;
      polling = true;
      try {
        await pollOnce();
      } finally {
        polling = false;
      }
    };

    const pollOnce = async () => {
      for (const paneId of watcher.livePaneIds()) {
        const seqBefore = socketSeq.get(paneId) ?? 0;
        try {
          const agent = await client.agentGet(paneId);
          if ((socketSeq.get(paneId) ?? 0) === seqBefore) emit(watcher.status(paneId, agent.status, now()));
          const at = await mtimeOf(transcriptPath(projectsRoot, agent));
          if (agent.sessionId !== knownSession.get(paneId)) {
            knownSession.set(paneId, agent.sessionId);
            watcher.sessionChanged(paneId, now(), at !== null);
          }
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
      onClose: (reason) =>
        fail(`[watch] lost herdr's event stream - ${reason}. Re-arm the watch once herdr is back.`, {
          type: "stream_lost",
          detail: reason,
        }),
    }).then(
      (s) => {
        stream = s;
        if (finished) {
          s.close();
          return;
        }
        // Reconcile right away: catches a stop that happened between the
        // first lookup and the subscription going live.
        void poll();
        timer = setInterval(() => void poll(), pollMs);
      },
      (error: unknown) =>
        fail(`[watch] could not subscribe to herdr events - ${messageOf(error)}`, {
          type: "subscribe_failed",
          detail: messageOf(error),
        }),
    );
  });
}
