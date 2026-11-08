// sources.ts: where the watcher gets an agent's facts and status events,
// one adapter per engine. run.ts drives both through this interface, so the
// rules (what to report, stall detection, stop summaries) stay engine-blind.
//
//   herdr: `agent get` + herdr's socket (`pane.agent_status_changed`);
//   core:  `terminal.get` + herdr-core's event stream via `hc connect`, and
//          the Claude session from ~/.claude/sessions/<pid>.json.

import type { CoreClient } from "../core/client.js";
import { subscribeCoreEvents, type CoreSubscribeOptions } from "../core/events.js";
import type { SessionLookup } from "../core/sessions.js";
import { CoreError, type CoreTerminal } from "../core/types.js";
import type { HerdrClient } from "../herdr/client.js";
import { toAgentStatus } from "../herdr/client.js";
import { subscribeEvents } from "../herdr/events.js";
import { HerdrError } from "../herdr/types.js";
import type { Engine } from "../bridge/route.js";
import type { WatchStatus } from "./watcher.js";

export interface SourceAgent {
  /** The stable id to watch it under: herdr's pane id, or the core address. */
  key: string;
  status: WatchStatus;
  /** "" when no Claude session is known. */
  sessionId: string;
  cwd: string;
}

export interface SourceHandlers {
  status(key: string, status: WatchStatus): void;
  gone(key: string, detail: string): void;
}

export interface WatchSource {
  engine: Engine;
  /** What to call it in a stream-lost line. */
  displayName: string;
  /** Throws; `goneDetail` says whether the error means it is gone. */
  get(id: string): Promise<SourceAgent>;
  /** The "gone" detail for an error from get(), or null when it is transient. */
  goneDetail(error: unknown): string | null;
  subscribe(keys: string[], handlers: SourceHandlers, onClose: (reason: string) => void): Promise<{ close(): void }>;
}

export function herdrSource(client: HerdrClient, socketPath: string): WatchSource {
  return {
    engine: "herdr",
    displayName: "herdr",
    async get(id) {
      const agent = await client.agentGet(id);
      return { key: agent.paneId, status: agent.status, sessionId: agent.sessionId, cwd: agent.cwd };
    },
    goneDetail(error) {
      return error instanceof HerdrError && error.code === "agent_not_found"
        ? "no longer running in herdr (pane closed or agent exited)"
        : null;
    },
    subscribe(keys, handlers, onClose) {
      return subscribeEvents({
        socketPath,
        subscriptions: keys.map((pane_id) => ({ type: "pane.agent_status_changed", pane_id })),
        onEvent: (event) => {
          if (event.event !== "pane.agent_status_changed") return;
          const paneId = event.data.pane_id;
          if (typeof paneId !== "string") return;
          // A null agent is the agent leaving the pane, not a status.
          if (event.data.agent === null) handlers.gone(paneId, "agent exited");
          else handlers.status(paneId, toAgentStatus(event.data.agent_status));
        },
        onClose,
      });
    },
  };
}

/** A core terminal's status as the watcher counts it; never-reported is "unknown". */
export function coreWatchStatus(terminal: CoreTerminal): WatchStatus {
  return terminal.status ?? "unknown";
}

const CORE_GONE_EVENTS: Record<string, string> = {
  finished: "its program ended (terminal finished)",
  lost: "its program was lost (core crash or logout)",
  removed: "terminal removed",
};

export function coreSource(
  core: CoreClient,
  sessions: SessionLookup,
  subscribe: (options: CoreSubscribeOptions) => ReturnType<typeof subscribeCoreEvents> = subscribeCoreEvents,
): WatchSource {
  return {
    engine: "core",
    displayName: "herdr-core (the Herdr app's engine)",
    async get(id) {
      const terminal = await core.terminalGet(id);
      if (terminal.state !== "live") throw new CoreError("finished", `terminal ${terminal.address} has finished`);
      return {
        key: terminal.address,
        status: coreWatchStatus(terminal),
        sessionId: (await sessions(terminal)) ?? "",
        cwd: terminal.cwd,
      };
    },
    goneDetail(error) {
      if (!(error instanceof CoreError)) return null;
      if (error.code === "not_found") return "no longer in herdr-core (terminal removed)";
      if (error.code === "finished") return "its program ended (terminal finished)";
      return null;
    },
    subscribe(keys, handlers, onClose) {
      const watched = new Set(keys);
      return subscribe({
        onEvent: (event) => {
          if (!watched.has(event.terminal)) return;
          const gone = CORE_GONE_EVENTS[event.type];
          if (gone) {
            handlers.gone(event.terminal, gone);
            return;
          }
          if (event.type !== "status" || !("status" in event.data)) return;
          const status = event.data.status;
          if (status === null) {
            // The program stopped reporting: the agent exited back to its shell.
            handlers.gone(event.terminal, "agent exited (it stopped reporting status)");
            return;
          }
          const state = typeof status === "object" && status !== null ? (status as { state?: unknown }).state : undefined;
          if (state === "idle" || state === "working" || state === "blocked" || state === "done" || state === "error") {
            handlers.status(event.terminal, state);
          }
        },
        onClose,
      });
    },
  };
}
