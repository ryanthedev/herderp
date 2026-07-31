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

/** Snapshot sources `agent read --source` accepts, verbatim from herdr
 * 0.7.5's help: `[possible values: visible, recent, recent-unwrapped,
 * detection]`, default `recent`. "detection" is the view herdr's own agent
 * detector works from - useful next to `agent explain` when a reported
 * status looks wrong. (It was missing from this union, so callers could not
 * ask for it even though the CLI accepts it; herdr rejects an unknown source
 * with `invalid read source: <value>` at exit 1.) */
export type AgentReadSource = "visible" | "recent" | "recent-unwrapped" | "detection";

export interface AgentReadOptions {
  source?: AgentReadSource;
  lines?: number;
  format?: "text" | "ansi";
  ansi?: boolean;
}

/**
 * States `agent wait --until` and `agent prompt --until` accept. Verified
 * against `herdr agent wait --help` on 0.7.5: `[possible values: idle,
 * working, blocked, done, unknown]` - identical to AgentStatus, "done"
 * included. (A previous version of this file asserted the opposite and
 * excluded "done"; it was wrong, and it excluded the single most useful state
 * to wait for, since "done" is where an agent rests after finishing.)
 */
export type AgentWaitStatus = AgentStatus;

/**
 * `--until` is repeatable, so `status` takes one state or several and the
 * wait resolves on the first match. Omit it entirely to get herdr's own
 * default, which is "idle, done, or blocked" - i.e. any settled state.
 * Without `timeoutMs` herdr waits indefinitely.
 */
export interface AgentWaitOptions {
  status?: AgentWaitStatus | AgentWaitStatus[];
  timeoutMs?: number;
}

/**
 * `agent prompt <TARGET> <TEXT> [OPTIONS]` - submits TEXT to the agent as a
 * prompt (submission included; this is not a keystroke channel).
 *
 * `wait` blocks until the agent settles after submission. herdr's own
 * semantics, quoted from `agent prompt --help`: from a non-working state it
 * first requires an observed state change within 5000ms, else it returns
 * `agent_prompt_stalled` (a shorter `timeoutMs` returns `timeout` instead);
 * it then matches idle/done/blocked by default, or exactly the `until` states.
 * It does NOT track turns - if the agent is already working, that in-flight
 * turn's completion can satisfy the wait.
 */
export interface AgentPromptOptions {
  wait?: boolean;
  until?: AgentWaitStatus | AgentWaitStatus[];
  timeoutMs?: number;
}

/**
 * Agent kinds `agent start --kind` accepts, verbatim from `agent start
 * --help` on herdr 0.7.5. herdr rejects anything outside this list at
 * argument parsing, so it is pinned here rather than left an open string.
 */
export type AgentKind =
  | "pi" | "claude" | "codex" | "gemini" | "cursor" | "devin" | "agy" | "cline"
  | "omp" | "mastracode" | "opencode" | "copilot" | "kimi" | "kiro" | "droid"
  | "amp" | "grok" | "hermes" | "kilo" | "qodercli" | "maki";

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

/**
 * `agent start <NAME> --kind <KIND> --pane <ID> [--timeout <MS>] [-- <args>]`,
 * verbatim from `agent start --help` on herdr 0.7.5.
 *
 * herdr does NOT create the pane: `paneId` must already exist and be sitting
 * at an interactive shell prompt. Start therefore composes with paneSplit /
 * tabCreate / workspaceCreate rather than replacing them - make the pane
 * first, then start into it.
 *
 * (An earlier version of this interface offered `cwd`, `workspaceId`, `tabId`,
 * `split`, `env` and `focus`. herdr accepts none of them - every one is
 * rejected with `unknown option` - and it required neither of the two flags
 * that are actually mandatory, so no call could ever succeed.)
 */
export interface AgentStartOptions {
  /** The label herdr registers the agent under; also a valid `target`. */
  name: string;
  kind: AgentKind;
  /** An EXISTING pane at its interactive shell prompt. */
  paneId: string;
  /** How long to wait for interactive readiness. herdr default 30000, max
   * 300000; herdr rejects anything larger at argument parsing. */
  timeoutMs?: number;
  /** Extra argv passed to the agent binary itself, after herdr's `--`. */
  argv?: string[];
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
