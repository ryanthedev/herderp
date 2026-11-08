// run.ts: the I/O half of `herderp watch`. Resolves the targets through
// their engine's WatchSource (sources.ts: herdr, or herdr-core for the Herdr
// app), subscribes to each engine's status events, polls each agent's
// liveness, status, and transcript, and prints the Watcher's events -
// one line each, flushed immediately, because the process runs under Claude
// Code's Monitor tool, where every stdout line becomes a notification.
//
// Activity signal: an agent's Claude Code transcript
// (~/.claude/projects/<slug>/<sessionId>.jsonl) is written within seconds of
// every step it takes, so its mtime is the heartbeat stall detection reads.
// The session id is re-read on every poll (it changes on /clear).
//
// Targets are `core:<address>` or `herdr:<target>`; a bare target is herdr,
// as it was before herdr-core support.
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
import { deriveSlug } from "../necromancy/core.js";
import type { Engine } from "../bridge/route.js";
import { herdrSource, type SourceAgent, type WatchSource } from "./sources.js";
import {
  formatEvent,
  formatEventJson,
  STOPPED_STATUSES,
  Watcher,
  type EventContext,
  type WatchEvent,
} from "./watcher.js";

export interface RunWatchOptions {
  /** `core:<address>`, `herdr:<agent name or pane id>`, or a bare herdr target. */
  targets: string[];
  stallMs?: number;
  /** Exit after the first event. */
  once?: boolean;
  json?: boolean;
  verbose?: boolean;
}

export interface RunWatchDeps {
  /** One source per engine. Default: herdr only, from `client` + `socketPath`. */
  sources?: Partial<Record<Engine, WatchSource>>;
  client?: HerdrClient;
  socketPath?: string;
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

/** `core:t3s` -> core t3s; `herdr:w1:p1` -> herdr w1:p1; anything else -> herdr, verbatim. */
export function parseTarget(token: string): { engine: Engine; id: string } {
  if (token.startsWith("core:")) return { engine: "core", id: token.slice("core:".length) };
  if (token.startsWith("herdr:")) return { engine: "herdr", id: token.slice("herdr:".length) };
  return { engine: "herdr", id: token };
}

function transcriptPath(projectsRoot: string, agent: SourceAgent): string | null {
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
  const { projectsRoot } = deps;
  const sources: Partial<Record<Engine, WatchSource>> =
    deps.sources ?? (deps.client && deps.socketPath ? { herdr: herdrSource(deps.client, deps.socketPath) } : {});
  const now = deps.now ?? Date.now;
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  const summaryDelayMs = deps.summaryDelayMs ?? DEFAULT_SUMMARY_DELAY_MS;
  /** Print one line: the text form, or the JSON record in json mode. */
  const say = (text: string, record: Record<string, unknown>) =>
    deps.write(options.json ? JSON.stringify(record) : text);

  // 1. Resolve every target up front; a typo fails fast, before anything is armed.
  const agents = new Map<string, { label: string; source: WatchSource; agent: SourceAgent }>();
  for (const token of options.targets) {
    const { engine, id: label } = parseTarget(token);
    const source = sources[engine];
    const engineTag = engine === "core" ? { engine } : {};
    if (!source) {
      const detail = `this watch has no ${engine} source`;
      say(`[${label}] not found - ${detail}`, { type: "not_found", label, ...engineTag, detail });
      return 2;
    }
    let agent: SourceAgent;
    try {
      agent = await source.get(label);
    } catch (error) {
      say(`[${label}] not found - ${messageOf(error)}`, { type: "not_found", label, ...engineTag, detail: messageOf(error) });
      return 2;
    }
    if (!agents.has(agent.key)) agents.set(agent.key, { label, source, agent });
  }

  // 2. Say what is being watched, including targets that have already stopped:
  // no further event will come for those, so this line is the only notice.
  const startedAt = now();
  const targets = [];
  for (const [paneId, { label, source, agent }] of agents) {
    const hasTranscript = (await mtimeOf(transcriptPath(projectsRoot, agent))) !== null;
    const noStall = options.stallMs !== undefined && !hasTranscript;
    targets.push({ label, paneId, status: agent.status, noStall });
    const session = agent.sessionId ? ` (session ${agent.sessionId.slice(0, 8)})` : "";
    const note = noStall ? " - no transcript yet, stall detection starts when one appears" : "";
    say(`[${label}] watching - currently ${agent.status}${session}${note}`, {
      type: "watching",
      label,
      ...(source.engine === "core" && { engine: "core" }),
      paneId,
      status: agent.status,
      ...(agent.sessionId && { sessionId: agent.sessionId }),
      ...(options.stallMs !== undefined && { stallDetection: !noStall }),
    });
  }
  const watcher = new Watcher(targets, startedAt, { stallMs: options.stallMs, verbose: options.verbose });
  // The session each target held at its last lookup. Status events carry no
  // session id, so this is how a session switch is noticed.
  const knownSession = new Map([...agents].map(([key, { agent }]) => [key, agent.sessionId]));
  const sourceOf = new Map([...agents].map(([key, { source }]) => [key, source]));

  return await new Promise<number>((resolve) => {
    const streams: Array<{ close(): void }> = [];
    let timer: ReturnType<typeof setInterval> | undefined;
    let finished = false;
    // Events print in arrival order even though stop summaries are async;
    // `pending` counts what is queued but not yet printed, so the watch never
    // exits with a notification still waiting (e.g. two departures at once).
    let queue: Promise<void> = Promise.resolve();
    let pending = 0;
    // Per-target count of streamed status events: a poll applies its status
    // only if this hasn't moved while it was in flight.
    const socketSeq = new Map<string, number>();

    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      if (timer) clearInterval(timer);
      for (const stream of streams) stream.close();
      resolve(code);
    };

    /**
     * A stop's summary. Started the moment the event is emitted - not when the
     * queue reaches it - so a /clear after the lookup can't swap the session
     * it quotes. A stop event names no session, so the lookup must agree with
     * the session last seen for that target; if it switched sessions in
     * between, which session stopped is uncertain and the line goes out
     * without a summary rather than with a possibly wrong one.
     */
    const contextFor = async (event: WatchEvent): Promise<EventContext> => {
      if (event.type !== "status" || !STOPPED_STATUSES.has(event.status)) return {};
      const expected = knownSession.get(event.paneId);
      let session: { sessionId: string; cwd: string };
      try {
        const agent = await sourceOf.get(event.paneId)!.get(event.paneId);
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

    const handlers = {
      status: (key: string, status: SourceAgent["status"]) => {
        socketSeq.set(key, (socketSeq.get(key) ?? 0) + 1);
        emit(watcher.status(key, status, now()));
      },
      gone: (key: string, detail: string) => {
        socketSeq.set(key, (socketSeq.get(key) ?? 0) + 1);
        emit(watcher.gone(key, detail));
      },
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
      for (const key of watcher.livePaneIds()) {
        const source = sourceOf.get(key)!;
        const seqBefore = socketSeq.get(key) ?? 0;
        try {
          const agent = await source.get(key);
          if ((socketSeq.get(key) ?? 0) === seqBefore) emit(watcher.status(key, agent.status, now()));
          const at = await mtimeOf(transcriptPath(projectsRoot, agent));
          if (agent.sessionId !== knownSession.get(key)) {
            knownSession.set(key, agent.sessionId);
            watcher.sessionChanged(key, now(), at !== null);
          }
          if (at !== null) watcher.activity(key, at);
        } catch (error) {
          const detail = source.goneDetail(error);
          if (detail !== null) emit(watcher.gone(key, detail));
          // any other failure is transient: the next poll tries again
        }
      }
      emit(watcher.tick(now()));
    };

    // Subscribe each engine that has a target; arm the poll once all are live.
    const byEngine = new Map<WatchSource, string[]>();
    for (const [key, source] of sourceOf) byEngine.set(source, [...(byEngine.get(source) ?? []), key]);
    Promise.all(
      [...byEngine].map(([source, keys]) =>
        source
          .subscribe(keys, handlers, (reason) =>
            fail(`[watch] lost ${source.displayName}'s event stream - ${reason}. Re-arm the watch once ${source.displayName} is back.`, {
              type: "stream_lost",
              ...(source.engine === "core" && { engine: "core" }),
              detail: reason,
            }),
          )
          .then(
            (stream) => {
              if (finished) stream.close();
              else streams.push(stream);
            },
            (error: unknown) => {
              fail(`[watch] could not subscribe to ${source.displayName} events - ${messageOf(error)}`, {
                type: "subscribe_failed",
                ...(source.engine === "core" && { engine: "core" }),
                detail: messageOf(error),
              });
              throw error;
            },
          ),
      ),
    ).then(
      () => {
        if (finished) return;
        // Reconcile right away: catches a stop that happened between the
        // first lookup and the subscription going live.
        void poll();
        timer = setInterval(() => void poll(), pollMs);
      },
      () => {
        // already reported by fail()
      },
    );
  });
}
