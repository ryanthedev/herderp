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

/**
 * A herdr tab within a workspace. `label` is the user-facing string herdr
 * shows and the user types after the colon in a `<workspace>:<tab>` handle
 * (auto-labeled "1", "2", ... but user-renameable, so not a reliable
 * ordinal). `number` is a GLOBAL monotonic counter across all workspaces
 * (verified live: one workspace's tabs can be number 7 and 8, another's a
 * lone number 21) - it orders tabs WITHIN a workspace but is not a
 * per-workspace 1-based index. `label` can be null if herdr reports none.
 */
export interface Tab {
  id: string;
  workspaceId: string;
  label: string | null;
  number: number;
  focused: boolean;
}

/**
 * A herdr pane. A pane may host an agent (`agent` = the CLI kind, e.g.
 * "claude") or be a plain shell (`agent` = "" and `sessionId` = ""). Mapped
 * tolerantly so a shell/non-claude pane never crashes a list - callers that
 * need a Claude session must check `agent === "claude"` and that `sessionId`
 * is a UUID themselves.
 */
export interface Pane {
  id: string;
  workspaceId: string;
  tabId: string;
  agent: string;
  sessionId: string;
  cwd: string;
  status: AgentStatus;
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

/** `agent wait --status` accepts only these four - NOT "done", which appears
 * in AgentStatus (a reported value) but is not waitable (verified against
 * `herdr agent wait --help`). Keep the two unions separate for that reason. */
export interface AgentWaitOptions {
  status: "idle" | "working" | "blocked" | "unknown";
  timeoutMs?: number;
}

export interface WorkspaceCreateOptions {
  cwd: string;
  label?: string;
  focus?: boolean;
}

/** Shared by `tab create` and `workspace create` - same flag set on both. */
export interface TabCreateOptions {
  workspaceId?: string;
  cwd?: string;
  label?: string;
  focus?: boolean;
}

/** `agent start <name> [flags] -- <argv...>`. `name` is the agent label herdr
 * registers; `argv` is the command line after the `--` separator. */
export interface AgentStartOptions {
  name: string;
  argv: string[];
  cwd?: string;
  workspaceId?: string;
  tabId?: string;
  split?: "right" | "down";
  env?: string[];
  focus?: boolean;
}

/**
 * One entry from `herdr worktree list`. Field names mirror the verified JSON
 * (`branch`, `path`, `label`, `is_*` flags, and `open_workspace_id` which is
 * present ONLY on a worktree currently open in a workspace - absent, not
 * null, otherwise).
 */
export interface Worktree {
  path: string;
  branch: string;
  label: string | null;
  isBare: boolean;
  isDetached: boolean;
  isLinkedWorktree: boolean;
  isPrunable: boolean;
  /** Empty string when the worktree is not open in any workspace. */
  openWorkspaceId: string;
}

/** Scope for the worktree subcommands: herdr accepts `--workspace ID` OR
 * `--cwd PATH`, never both. Bare (neither) resolves against herdr's FOCUSED
 * workspace - not the caller's $HERDR_WORKSPACE_ID (verified live), which is
 * why callers should pass one explicitly. */
export interface WorktreeScope {
  workspaceId?: string;
  cwd?: string;
}

export interface WorktreeCreateOptions extends WorktreeScope {
  branch?: string;
  base?: string;
  path?: string;
  label?: string;
  focus?: boolean;
}

export interface WorktreeOpenOptions extends WorktreeScope {
  path?: string;
  branch?: string;
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
