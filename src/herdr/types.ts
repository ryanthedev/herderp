// Seam types shared by the HerdrClient and every curated/necromancy tool that
// consumes it. These are intentionally the minimal fields Phase 3 depends on
// (see the plan's Produces section) - do not add fields speculatively.

/** Status values herdr reports for an agent. "done" is part of the pinned
 * seam even though it has not been observed live - unrecognized/future
 * status strings normalize to "unknown" rather than widening this union. */
export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface Agent {
  agent: string;
  /** From `agent_session.value` - the agent CLI's own session id (a Claude
   * Code session UUID, for Claude agents). Empty string if herdr reports no
   * agent_session (defensive fallback; the seam type requires a string). */
  sessionId: string;
  status: AgentStatus;
  cwd: string;
  workspaceId: string;
  tabId: string;
  paneId: string;
}

export interface Workspace {
  id: string;
  label: string | null;
  /** herdr 0.7.1's `workspace list`/`workspace get` do not expose an
   * identity_cwd field directly (verified live) - HerdrClient derives this
   * from the workspace's first pane's cwd. See client.ts. */
  cwd: string;
  tabCount: number;
  paneCount: number;
}

export interface Session {
  name: string;
  default: boolean;
  running: boolean;
}

export interface AgentReadOptions {
  source?: "visible" | "recent" | "recent-unwrapped";
  lines?: number;
  format?: "text" | "ansi";
  ansi?: boolean;
}

export interface AgentWaitOptions {
  status: "idle" | "working" | "blocked" | "unknown";
  timeoutMs?: number;
}

export interface WorkspaceCreateOptions {
  cwd: string;
  label?: string;
  focus?: boolean;
}

/**
 * Typed error for every HerdrClient failure mode: a herdr process that never
 * started, a nonzero exit (JSON-shaped or plain-text), unparseable stdout, or
 * a timed-out `agent wait`. Callers can rely on `.code` + `.message` - never
 * a raw thrown string.
 */
export class HerdrError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "HerdrError";
    this.code = code;
  }
}
