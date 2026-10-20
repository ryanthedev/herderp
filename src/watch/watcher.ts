// watcher.ts: the pure state machine behind `herderp watch`. It turns raw
// signals about watched agents - status changes, transcript activity, the
// agent disappearing, clock ticks - into the few events a commanding agent
// should be woken for. No I/O and no timers: every input carries `now`, so
// the rules are unit-testable with a fake clock.
//
// What is worth a wake-up (everything else stays silent, because each event
// becomes a notification in the watcher's conversation):
//   - stopped: the agent reached done / idle / blocked (blocked = it needs
//     input, usually a permission prompt or a question);
//   - stalled: it should be working but nothing has happened for stallMs -
//     no status change and no transcript write;
//   - gone: the agent is no longer there (pane closed, agent exited);
//   - working: only with `verbose`, when it starts again.
// A repeat of the same status is not an event.

import type { AgentStatus } from "../herdr/types.js";

/** Statuses that mean the agent has stopped and is waiting on someone. */
export const STOPPED_STATUSES: ReadonlySet<AgentStatus> = new Set(["done", "idle", "blocked"]);

export interface WatchTarget {
  /** How the user named it (agent name or pane id) - the label on every line. */
  label: string;
  paneId: string;
  status: AgentStatus;
  /** No transcript to watch (yet), so silence proves nothing: no stall
   * reports until the first activity() shows one exists. */
  noStall?: boolean;
}

export interface WatchOptions {
  /** Report an agent that is working/unknown yet quiet for this long. Off when unset. */
  stallMs?: number;
  /** Also report transitions back to working. */
  verbose?: boolean;
}

export type WatchEvent =
  | { type: "status"; label: string; paneId: string; status: AgentStatus; previous: AgentStatus; inPreviousMs: number }
  | { type: "stalled"; label: string; paneId: string; status: AgentStatus; quietMs: number }
  | { type: "gone"; label: string; paneId: string; detail: string };

interface PaneState {
  label: string;
  status: AgentStatus;
  statusSince: number;
  lastActivity: number;
  stallReported: boolean;
  gone: boolean;
  noStall: boolean;
}

export class Watcher {
  private readonly panes = new Map<string, PaneState>();

  constructor(
    targets: WatchTarget[],
    now: number,
    private readonly options: WatchOptions = {},
  ) {
    for (const t of targets) {
      this.panes.set(t.paneId, {
        label: t.label,
        status: t.status,
        statusSince: now,
        lastActivity: now,
        stallReported: false,
        gone: false,
        noStall: t.noStall === true,
      });
    }
  }

  /** Pane ids still being watched. */
  livePaneIds(): string[] {
    return [...this.panes].filter(([, s]) => !s.gone).map(([id]) => id);
  }

  allGone(): boolean {
    return this.livePaneIds().length === 0;
  }

  /** herdr reported a status for a pane. Unknown panes are ignored. */
  status(paneId: string, status: AgentStatus, now: number): WatchEvent[] {
    const s = this.panes.get(paneId);
    if (!s || s.gone || s.status === status) return [];
    const previous = s.status;
    const inPreviousMs = now - s.statusSince;
    s.status = status;
    s.statusSince = now;
    s.lastActivity = now;
    s.stallReported = false;
    const report = STOPPED_STATUSES.has(status) || (status === "working" && this.options.verbose === true);
    return report ? [{ type: "status", label: s.label, paneId, status, previous, inPreviousMs }] : [];
  }

  /** The pane's transcript was written at `at` (ms). Older-than-known writes
   * are ignored, but any write proves a transcript exists, which turns stall
   * detection back on for a target that started without one. */
  activity(paneId: string, at: number): void {
    const s = this.panes.get(paneId);
    if (!s || s.gone) return;
    s.noStall = false;
    if (at <= s.lastActivity) return;
    s.lastActivity = at;
    s.stallReported = false;
  }

  /** The pane moved to a new session (/clear, restart): the old transcript's
   * heartbeat no longer says anything, so restart the quiet clock and - when
   * the new session has no transcript yet - hold stall reports until it does. */
  sessionChanged(paneId: string, now: number, hasTranscript: boolean): void {
    const s = this.panes.get(paneId);
    if (!s || s.gone) return;
    s.lastActivity = now;
    s.stallReported = false;
    if (!hasTranscript) s.noStall = true;
  }

  /** The agent is gone (pane closed, agent exited, target no longer resolves). */
  gone(paneId: string, detail: string): WatchEvent[] {
    const s = this.panes.get(paneId);
    if (!s || s.gone) return [];
    s.gone = true;
    return [{ type: "gone", label: s.label, paneId, detail }];
  }

  /** Periodic check: report agents that should be working but have gone quiet. */
  tick(now: number): WatchEvent[] {
    const { stallMs } = this.options;
    if (stallMs === undefined) return [];
    const events: WatchEvent[] = [];
    for (const [paneId, s] of this.panes) {
      if (s.gone || s.noStall || s.stallReported || STOPPED_STATUSES.has(s.status)) continue;
      const quietMs = now - Math.max(s.lastActivity, s.statusSince);
      if (quietMs >= stallMs) {
        s.stallReported = true;
        events.push({ type: "stalled", label: s.label, paneId, status: s.status, quietMs });
      }
    }
    return events;
  }
}

/** "4m", "1h12m", "35s" - coarse, for humans reading a notification. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h${minutes}m`;
}

/** Parse "90s", "10m", "1h", or plain milliseconds. Null when unparseable. */
export function parseDuration(raw: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(raw.trim());
  if (!m) return null;
  const value = Number(m[1]);
  const unit = m[2] ?? "ms";
  const factor = unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : unit === "s" ? 1000 : 1;
  const ms = Math.round(value * factor);
  return ms > 0 ? ms : null;
}

/** Extra context the I/O layer attaches to an event before it is printed. */
export interface EventContext {
  /** The agent's last assistant text, for stop events. */
  lastState?: string;
  sessionId?: string;
}

const SUMMARY_CHARS = 200;

function clip(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= SUMMARY_CHARS ? collapsed : `${collapsed.slice(0, SUMMARY_CHARS - 1)}…`;
}

/** One human-readable line per event - the text a Monitor notification shows. */
export function formatEvent(event: WatchEvent, context: EventContext = {}): string {
  const tag = `[${event.label}]`;
  const session = context.sessionId ? ` (session ${context.sessionId.slice(0, 8)})` : "";
  switch (event.type) {
    case "status": {
      const after = event.previous === "working" ? ` after ${formatDuration(event.inPreviousMs)} working` : "";
      const last = context.lastState ? ` - last: "${clip(context.lastState)}"` : "";
      if (event.status === "blocked") {
        return `${tag} blocked${after} - needs input (a permission prompt or a question)${last}${session}`;
      }
      if (event.status === "working") return `${tag} working again${session}`;
      return `${tag} ${event.status}${after}${last}${session}`;
    }
    case "stalled":
      return `${tag} stalled - no activity for ${formatDuration(event.quietMs)} while ${event.status}${session}`;
    case "gone":
      return `${tag} gone - ${event.detail}`;
  }
}

/** The same event as one JSON line, for a machine reader. */
export function formatEventJson(event: WatchEvent, context: EventContext = {}): string {
  return JSON.stringify({ ...event, ...context });
}
