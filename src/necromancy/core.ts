// Necromancy core: the deep module behind the necromancy_* tools. It hides
// everything about locating and reading Claude Code sessions on disk:
//   - the Claude Code graveyard layout (~/.claude/projects/<slug>/<uuid>.jsonl)
//     and its slug rule
//   - jsonl preview parsing and the stat-gated skip policy for empty/
//     oversized/malformed files (oversized files are never even read)
//   - joining on-disk spaces with live herdr workspaces/agents
// Design-it-twice comparison (factory vs free fns vs class) lives in
// .code-foundations/build/2026-07-09-herderp-plugin-necromancy-phase-3-discovery.md
//
// SECURITY BARRICADE: a session's sessionId is untrusted external input that
// flows into an on-disk path. It is validated against a strict UUID regex
// (UUID_RE) BEFORE any path is constructed - see loadTurns's gate - so a
// non-UUID id can never reach the filesystem.

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HerdrClient } from "../herdr/client.js";
import { HerdrError, type Pane, type Tab, type Workspace } from "../herdr/types.js";
import { parseSessionPreview } from "./preview.js";
import { extractAnchors, type Anchors } from "./anchors.js";
import {
  compileSearchPattern,
  DEFAULT_MAX_OUTLINE_ENTRIES,
  DEFAULT_MAX_READ_BYTES,
  DEFAULT_MAX_READ_SPAN,
  DEFAULT_MAX_SEARCH_MATCHES,
  outlineTurns,
  parseTurns,
  readTurns,
  searchTurns,
  summarizeTurnMatches,
  type OutlineOptions,
  type OutlineResult,
  type ReadResult,
  type SearchOptions,
  type SearchResult,
  type TurnRole,
} from "./reader.js";

export type { Turn, TurnRole, OutlineEntry, SearchMatch, FullEntry } from "./reader.js";
export type { Anchors } from "./anchors.js";

/**
 * Claude Code's project-directory slug: every character that is not
 * `[A-Za-z0-9]` becomes `-` - `/`, `.`, `_`, `@`, and any other punctuation
 * all map to `-`. A per-character map over the raw string (NOT path
 * normalization, which would collapse the dots the slug must preserve), and
 * NOT collapsing: adjacent replaced chars each yield their own `-`
 * (`/a/.b` -> `-a--b`, `prod-_x` -> `prod--x`). Restricting the map to `/`
 * and `.` silently breaks any cwd containing `@`, `_`, etc. - the derived
 * slug keeps the literal char while the on-disk dir has `-`, so the space is
 * never found. Reversal is lossy (`-` may mean any replaced char or a literal
 * `-`), which is why findSpaces recovers cwds from live workspaces or session
 * lines instead of un-slugging.
 */
export function deriveSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

export type NecromancyErrorCode = "invalid_session_id" | "session_not_found" | "invalid_regex";

/** Typed rejection for the session-id validation gate - never a raw string throw. */
export class NecromancyError extends Error {
  readonly code: NecromancyErrorCode;

  constructor(code: NecromancyErrorCode, message: string) {
    super(message);
    this.name = "NecromancyError";
    this.code = code;
  }
}

export interface NecromancyOptions {
  client: HerdrClient;
  /** Graveyard root. Default: ~/.claude/projects. Tests inject a temp fixture dir. */
  projectsRoot?: string;
  /** Session files larger than this are skipped by stat alone - never read. Default 32 MiB. */
  maxSessionBytes?: number;
  /** Max spaces per findSpaces call (newest-activity first). Default 40 - a full dump of every
   * project dir routinely blows the tool-result token cap, so the list is always bounded. */
  maxSpaces?: number;
  /** Max entries per sessionOutline page. Default 200. */
  maxOutlineEntries?: number;
  /** Max matches per sessionSearch call. Default 50. */
  maxSearchMatches?: number;
  /** Max total bytes per sessionRead response. Default 64 KiB. */
  maxReadBytes?: number;
  /** Max entry span per sessionRead call. Default 200. */
  maxReadSpan?: number;
  /** Max matching sessions per searchAllSessions call (newest-activity first). Default 25. */
  maxSessionHits?: number;
  /** Max session files whose CONTENT searchAllSessions reads before it stops
   * (newest-mtime first). Default 200 - a machine holds thousands of
   * transcripts and a cross-space search would otherwise read them all. */
  maxScannedSessions?: number;
}

export interface SpaceInfo {
  cwd: string;
  label: string | null;
  workspaceId: string | null;
  sessionCount: number;
  lastActivity: number | null;
}

export interface FindSpacesOptions {
  /** Case-insensitive substring narrowing over each space's cwd/label/workspaceId. */
  query?: string;
  /** Max spaces returned (newest-activity first). Defaults to the configured maxSpaces. */
  limit?: number;
}

export interface FindSpacesResult {
  /** Matching spaces, newest-activity first, capped to `limit`. */
  spaces: SpaceInfo[];
  /** Total spaces that matched before the cap - so a caller can say "40 of 976". */
  total: number;
  /** True when more matched than were returned: narrow with `query` rather than assuming it's all. */
  truncated: boolean;
}

export interface SearchAllSessionsOptions {
  /** Case-insensitive substring over turn text, or a regex when `regex` is set. */
  query: string;
  /** One space's cwd to confine the scan to. Omitted: every space in the
   * graveyard. Named `cwd` to match every other tool's space argument (the
   * value is the same one `find_spaces` returns as `cwd`). */
  cwd?: string;
  /** Max matching sessions returned (newest-activity first). Defaults to the configured maxSessionHits. */
  limit?: number;
  regex?: boolean;
  /** Max session files read before the scan stops. Defaults to the configured maxScannedSessions. */
  maxSessions?: number;
}

/** One SESSION that matched - not one match. `matchCount` is how many of its
 * turns hit; index/role/tool/snippet describe only the first of them. */
export interface SessionSearchHit {
  /** The space this session lived in (its cwd), ready to feed back into any reader tool. */
  cwd: string;
  sessionId: string;
  matchCount: number;
  /** Turn index of the first match - directly addressable by sessionRead. */
  index: number;
  role: TurnRole;
  tool?: string;
  snippet: string;
  /** The session file's mtime: its last activity, and the sort key. */
  mtime: number;
  /** Absent only when the transcript had no parseable preview (malformed jsonl). */
  messageCount?: number;
}

export interface SearchAllSessionsResult {
  /** Matching sessions, newest-activity first, capped to `limit`. */
  sessions: SessionSearchHit[];
  /** Sessions that matched among those scanned - so a caller can say "25 of 60". */
  total: number;
  /** True when more sessions matched than were returned: narrow the query or raise limit. */
  truncated: boolean;
  /** Session files actually read (the stat-gated ones), newest-mtime first. */
  scanned: number;
  /** True when the maxSessions cap stopped the scan with candidate files left
   * unread: everything older than the last scanned session was never looked
   * at, so an empty/short result is NOT proof the query isn't there. */
  scanTruncated: boolean;
}

export interface SessionInfo {
  /** The Claude Code session id (a UUID). Named `sessionId`, not `id`, so it
   * feeds straight into the reading tools' `sessionId` param without a
   * silent rename - the model joins these across tool calls, so one name
   * across the whole surface matters more than local brevity. */
  sessionId: string;
  cwd: string;
  mtime: number;
  live: boolean;
  preview: string;
  messageCount: number;
  /** The herdr handle (`<workspace-label>:<tab-label>`) for a live session,
   * so a listing shows which live agent each session is. Absent for
   * non-live sessions and when herdr is degraded/unreachable. */
  handle?: string;
  /** True only for the session whose id equals the caller-supplied
   * currentSessionId - the session the ghost command is running in, which a
   * catch-up must never read as its target. */
  current?: boolean;
}

export interface ListSessionsResult {
  sessions: SessionInfo[];
  /** True when herdr was unreachable, so `live`/`handle` could not be
   * determined - the on-disk sessions are still returned (live all false),
   * never a raw error. Callers must say live status is unknown. */
  degraded: boolean;
}

/** Resolution of a `<workspace>:<tab>` herdr handle to a live session. A
 * discriminated union so ambiguity and misses are actionable DATA (candidates
 * to present, a reason to fall through to the on-disk index) rather than
 * thrown errors. herdr being unreachable still throws HerdrError. */
export type ResolveHandleResult =
  | {
      status: "resolved";
      sessionId: string;
      cwd: string;
      workspaceLabel: string;
      /** The tab label actually matched - echo it so the caller can flag when
       * it differs from what the user typed (e.g. typed ":1", matched "2"). */
      matchedTabLabel: string | null;
      /** Normalized `<workspaceLabel>:<matchedTabLabel>` (or just the label). */
      handle: string;
      live: true;
      isCurrent: boolean;
    }
  | {
      status: "ambiguous_workspace";
      query: string;
      candidates: { workspaceId: string; label: string | null; cwd: string }[];
    }
  | {
      status: "ambiguous_pane";
      workspaceLabel: string;
      candidates: { paneId: string; sessionId: string; tabLabel: string | null; cwd: string }[];
    }
  | {
      status: "not_found";
      reason: "invalid_handle" | "no_current_workspace" | "workspace" | "tab" | "no_claude_agent";
      detail: string;
    };

export interface ResolveHandleOptions {
  handle: string;
  /** The current workspace id (herdr's HERDR_WORKSPACE_ID), used only to
   * resolve a label-less `:<tab>` / bare handle against the running space. */
  workspaceId?: string;
  /** The running session's own id (caller-supplied from CLAUDE_CODE_SESSION_ID
   * in fresh Bash env - never the MCP server's stale spawn env). */
  currentSessionId?: string;
}

export type Necromancy = ReturnType<typeof createNecromancy>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_MAX_SESSION_BYTES = 32 * 1024 * 1024;
export const DEFAULT_MAX_SPACES = 40;
export const DEFAULT_MAX_SESSION_HITS = 25;
/** The hard bound on a cross-session search: at most this many session files
 * are ever read per call, newest-mtime first. Every other cap in here bounds a
 * RESPONSE; this one bounds the WORK, because searchAllSessions with no
 * `space` is otherwise "read every transcript on the machine". */
export const DEFAULT_MAX_SCANNED_SESSIONS = 200;

/** A UUID-named .jsonl session file found on disk (stat metadata only). */
interface SessionFile {
  id: string;
  path: string;
  size: number;
  mtimeMs: number;
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

type WorkspaceMatch =
  | { kind: "one"; workspace: Workspace }
  | { kind: "many"; workspaces: Workspace[] }
  | { kind: "none" };

/**
 * Matches a workspace by label the way a user reads it: an exact
 * (case-insensitive) label match wins outright; only if none match exactly do
 * we widen to substring (so `grug` finds `grug-brain.mcp`). Either tier can be
 * ambiguous - the caller presents the candidates rather than guessing.
 * Label-less workspaces are never matched by a non-empty query.
 */
function matchWorkspace(workspaces: Workspace[], label: string): WorkspaceMatch {
  const needle = label.toLowerCase();
  const named = workspaces.filter((w): w is Workspace & { label: string } => w.label != null);
  const exact = named.filter((w) => w.label.toLowerCase() === needle);
  const pool = exact.length > 0 ? exact : named.filter((w) => w.label.toLowerCase().includes(needle));
  if (pool.length === 1) return { kind: "one", workspace: pool[0]! };
  if (pool.length > 1) return { kind: "many", workspaces: pool };
  return { kind: "none" };
}

/**
 * Resolves the part after the colon in a `<workspace>:<tab>` handle to a tab.
 * An exact (case-insensitive) tab-label match wins - herdr auto-labels tabs
 * "1","2",... so `upublish:1` matches the tab literally labeled "1". Only when
 * no label matches AND the part is a positive integer N do we fall back to the
 * Nth tab by herdr's global `number` ascending (herdr's `number` is NOT a
 * per-workspace 1-based index, so we sort-then-index rather than compare). A
 * duplicate label resolves to the lowest-numbered of them.
 */
function matchTab(tabs: Tab[], tabPart: string): Tab | undefined {
  const byNumber = [...tabs].sort((a, b) => a.number - b.number);
  const needle = tabPart.toLowerCase();
  const exact = byNumber.filter((t) => t.label != null && t.label.toLowerCase() === needle);
  if (exact.length > 0) return exact[0];
  if (/^[1-9]\d*$/.test(tabPart)) {
    const n = Number(tabPart);
    if (n >= 1 && n <= byNumber.length) return byNumber[n - 1];
  }
  return undefined;
}

export function createNecromancy(options: NecromancyOptions) {
  const {
    client,
    projectsRoot = join(homedir(), ".claude", "projects"),
    maxSessionBytes = DEFAULT_MAX_SESSION_BYTES,
    maxSpaces = DEFAULT_MAX_SPACES,
    maxOutlineEntries = DEFAULT_MAX_OUTLINE_ENTRIES,
    maxSearchMatches = DEFAULT_MAX_SEARCH_MATCHES,
    maxReadBytes = DEFAULT_MAX_READ_BYTES,
    maxReadSpan = DEFAULT_MAX_READ_SPAN,
    maxSessionHits = DEFAULT_MAX_SESSION_HITS,
    maxScannedSessions = DEFAULT_MAX_SCANNED_SESSIONS,
  } = options;

  /**
   * UUID-named `.jsonl` files directly inside `dir`, newest-mtime first.
   * No recursion, so nested dirs (e.g. `<slug>/.../subagents/`) are excluded
   * by construction (DW-3.3). Non-UUID filenames are not sessions and are
   * skipped. A missing dir is an empty space, not an error.
   */
  async function scanSessionFiles(dir: string): Promise<SessionFile[]> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isEnoent(error)) return [];
      throw error; // permission problems etc. stay loud, never silently empty
    }
    const files: SessionFile[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const id = entry.name.slice(0, -".jsonl".length);
      if (!UUID_RE.test(id)) continue;
      const path = join(dir, entry.name);
      try {
        const { size, mtimeMs } = await stat(path);
        files.push({ id, path, size, mtimeMs });
      } catch (error) {
        if (!isEnoent(error)) throw error; // ENOENT = deleted between readdir and stat: skip
      }
    }
    return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  /** Empty and oversized files are skipped by stat alone - content never read. */
  function withinSizeGate(file: SessionFile): boolean {
    return file.size > 0 && file.size <= maxSessionBytes;
  }

  async function readSessionText(path: string): Promise<string | null> {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (isEnoent(error)) return null; // deleted mid-scan: skip
      throw error;
    }
  }

  /**
   * Slug reversal is lossy, so recover a space's real cwd from the `cwd`
   * field session lines carry (newest readable session first). Null when no
   * session yields one - the caller degrades to the raw slug.
   */
  async function cwdFromSessions(files: SessionFile[]): Promise<string | null> {
    for (const file of files) {
      if (!withinSizeGate(file)) continue;
      const text = await readSessionText(file.path);
      if (text === null) continue;
      const cwd = cwdFromText(text);
      if (cwd !== null) return cwd;
    }
    return null;
  }

  /** The first non-empty `cwd` a session's lines carry, or null. */
  function cwdFromText(text: string): string | null {
    for (const line of text.split("\n")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // malformed line: keep scanning (DW-3.3 skip policy)
      }
      const cwd = (parsed as { cwd?: unknown } | null)?.cwd;
      if (typeof cwd === "string" && cwd !== "") return cwd;
    }
    return null;
  }

  /**
   * Spaces from the on-disk graveyard joined with live herdr workspaces,
   * newest-activity first and capped: a full dump of every project dir (the
   * user's machine routinely has hundreds) blows the tool-result token cap, so
   * the list is always bounded and `query` narrows it. `total`/`truncated`
   * report how many matched beyond the cap so a caller can stay honest.
   */
  async function findSpaces(options: FindSpacesOptions = {}): Promise<FindSpacesResult> {
    const { query, limit = maxSpaces } = options;
    let entries;
    try {
      entries = await readdir(projectsRoot, { withFileTypes: true });
    } catch (error) {
      if (isEnoent(error)) return { spaces: [], total: 0, truncated: false }; // no graveyard at all: not a crash
      throw error;
    }
    const dirs = entries.filter((entry) => entry.isDirectory());
    if (dirs.length === 0) return { spaces: [], total: 0, truncated: false };

    // Join key: slug(workspace.cwd) == graveyard dir name. Workspaces with
    // cwd "" (paneless - documented Phase 2 fallback) carry no join signal;
    // first-listed wins when two workspaces share a cwd.
    const liveBySlug = new Map<string, { id: string; label: string | null; cwd: string }>();
    for (const workspace of await client.workspaceList()) {
      if (workspace.cwd === "") continue;
      const slug = deriveSlug(workspace.cwd);
      if (!liveBySlug.has(slug)) liveBySlug.set(slug, workspace);
    }

    const spaces: SpaceInfo[] = [];
    for (const dir of dirs) {
      const files = await scanSessionFiles(join(projectsRoot, dir.name));
      const live = liveBySlug.get(dir.name);
      const cwd = live?.cwd ?? (await cwdFromSessions(files)) ?? dir.name; // last resort: raw slug (degraded, documented)
      spaces.push({
        cwd,
        label: live?.label ?? null,
        workspaceId: live?.id ?? null,
        sessionCount: files.length,
        lastActivity: files[0]?.mtimeMs ?? null,
      });
    }

    const needle = query?.trim().toLowerCase();
    const matched = needle
      ? spaces.filter(
          (space) =>
            space.cwd.toLowerCase().includes(needle) ||
            (space.label?.toLowerCase().includes(needle) ?? false) ||
            (space.workspaceId?.toLowerCase().includes(needle) ?? false),
        )
      : spaces;
    // Newest-active first so the default (uncapped-query) page is the spaces a
    // catch-up most likely wants; null lastActivity (empty spaces) sorts last.
    matched.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));

    const total = matched.length;
    const capped = matched.slice(0, Math.max(0, limit));
    return { spaces: capped, total, truncated: capped.length < total };
  }

  async function listSessions(
    cwd: string,
    options: { currentSessionId?: string } = {},
  ): Promise<ListSessionsResult> {
    const { currentSessionId } = options;
    const files = await scanSessionFiles(join(projectsRoot, deriveSlug(cwd)));
    if (files.length === 0) return { sessions: [], degraded: false };

    // Disk drives the list (DW-3.5): a live sessionId with no on-disk file
    // simply never matches. The herdr join (live flag + `<label>:<tab>` handle
    // enrichment) is BEST-EFFORT: if herdr is unreachable we degrade to
    // live:false + degraded:true and still return every on-disk session,
    // because those files need no herdr at all. This deliberately reverses the
    // original "propagate loud" choice - a herdr outage must not hide the
    // graveyard that reading depends on - but stays honest via `degraded`.
    const liveIds = new Set<string>();
    const handleBySession = new Map<string, string>();
    let degraded = false;
    let agents;
    try {
      agents = await client.agentList();
    } catch (error) {
      if (!(error instanceof HerdrError)) throw error; // non-herdr faults stay loud
      agents = null;
      degraded = true; // live status is unknown - the whole point of `degraded`
    }
    if (agents) {
      for (const agent of agents) if (agent.sessionId) liveIds.add(agent.sessionId);
      // Handle enrichment sits ON TOP of the live flag and needs two more herdr
      // calls; if only those fail we keep the (known) live flags and just skip
      // handles - a missing handle is not a degraded listing.
      try {
        const [workspaces, tabs] = await Promise.all([client.workspaceList(), client.tabList()]);
        const wsLabelById = new Map(workspaces.map((w) => [w.id, w.label ?? w.id]));
        const tabLabelById = new Map(tabs.map((t) => [t.id, t.label]));
        for (const agent of agents) {
          if (!UUID_RE.test(agent.sessionId)) continue;
          const wsLabel = wsLabelById.get(agent.workspaceId);
          if (wsLabel === undefined) continue;
          const tabLabel = tabLabelById.get(agent.tabId);
          handleBySession.set(agent.sessionId, tabLabel != null ? `${wsLabel}:${tabLabel}` : wsLabel);
        }
      } catch (error) {
        if (!(error instanceof HerdrError)) throw error; // non-herdr faults stay loud
      }
    }

    const sessions: SessionInfo[] = [];
    for (const file of files) {
      if (!withinSizeGate(file)) continue;
      const text = await readSessionText(file.path);
      if (text === null) continue;
      const parsed = parseSessionPreview(text);
      if (!parsed) continue; // malformed jsonl: skip, never crash
      const handle = handleBySession.get(file.id);
      sessions.push({
        sessionId: file.id,
        cwd,
        mtime: file.mtimeMs,
        live: liveIds.has(file.id),
        preview: parsed.preview,
        messageCount: parsed.messageCount,
        ...(handle !== undefined ? { handle } : {}),
        ...(currentSessionId !== undefined && file.id === currentSessionId ? { current: true } : {}),
      });
    }
    return { sessions, degraded }; // scanSessionFiles already ordered newest first
  }

  /**
   * Every session file in scope, newest-mtime first: one space's when `space`
   * is a cwd, otherwise every space in the graveyard. Metadata only (readdir +
   * stat) - no transcript is read here, so the global ordering that decides
   * which files the scan budget is spent on is cheap.
   */
  async function candidateSessions(space?: string): Promise<Array<{ file: SessionFile; slug: string }>> {
    const candidates: Array<{ file: SessionFile; slug: string }> = [];
    if (space !== undefined) {
      const slug = deriveSlug(space);
      for (const file of await scanSessionFiles(join(projectsRoot, slug))) candidates.push({ file, slug });
    } else {
      let entries;
      try {
        entries = await readdir(projectsRoot, { withFileTypes: true });
      } catch (error) {
        if (isEnoent(error)) return []; // no graveyard at all: not a crash
        throw error;
      }
      for (const dir of entries) {
        if (!dir.isDirectory()) continue;
        for (const file of await scanSessionFiles(join(projectsRoot, dir.name))) {
          candidates.push({ file, slug: dir.name });
        }
      }
    }
    return candidates.sort((a, b) => b.file.mtimeMs - a.file.mtimeMs);
  }

  /**
   * Content search ACROSS sessions - the "I know what happened, not where"
   * entry point, where findSpaces/listSessions/sessionSearch require knowing
   * the space first. Answers with one entry per matching SESSION (matchCount
   * says how many of its turns hit; only the first is rendered), newest
   * activity first.
   *
   * Two independent bounds, both reported rather than silent:
   *   - `limit` caps the RESPONSE (total/truncated, exactly like findSpaces).
   *   - `maxSessions` caps the WORK. Files are visited newest-mtime first and
   *     the scan stops dead at the cap (scanned/scanTruncated), because with no
   *     `space` this would otherwise read every transcript on the machine. The
   *     stat gate still applies first, so empty/oversized files cost neither a
   *     read nor a slot in the budget.
   */
  async function searchAllSessions(options: SearchAllSessionsOptions): Promise<SearchAllSessionsResult> {
    const { query, cwd: scopeCwd, limit = maxSessionHits, regex = false, maxSessions = maxScannedSessions } = options;

    // searchTurns treats an invalid pattern as a literal substring; a scan of
    // hundreds of files must not silently answer a different question than the
    // caller asked, so here it is a typed error instead.
    if (regex && compileSearchPattern(query) === null) {
      throw new NecromancyError("invalid_regex", `not a valid regular expression: ${JSON.stringify(query.slice(0, 80))}`);
    }

    // Slug -> cwd, resolved from the transcript we already hold (never a second
    // read) and only for spaces that produced a hit. Degrades to the raw slug
    // like findSpaces does when no line carries a cwd.
    const cwdBySlug = new Map<string, string>();
    if (scopeCwd !== undefined) cwdBySlug.set(deriveSlug(scopeCwd), scopeCwd);

    const hits: SessionSearchHit[] = [];
    let scanned = 0;
    let scanTruncated = false;
    for (const { file, slug } of await candidateSessions(scopeCwd)) {
      if (scanned >= maxSessions) {
        scanTruncated = true; // candidates remain: say so, never truncate silently
        break;
      }
      if (!withinSizeGate(file)) continue;
      const text = await readSessionText(file.path);
      if (text === null) continue; // deleted mid-scan: skip
      scanned += 1;

      const { matchCount, first } = summarizeTurnMatches(parseTurns(text), query, { regex });
      if (!first) continue;
      let cwd = cwdBySlug.get(slug);
      if (cwd === undefined) {
        cwd = cwdFromText(text) ?? slug;
        cwdBySlug.set(slug, cwd);
      }
      const preview = parseSessionPreview(text);
      hits.push({
        cwd,
        sessionId: file.id,
        matchCount,
        ...first,
        mtime: file.mtimeMs,
        ...(preview ? { messageCount: preview.messageCount } : {}),
      });
    }

    // Candidates were visited newest-first, so hits are already in that order.
    const total = hits.length;
    const capped = hits.slice(0, Math.max(0, limit));
    return { sessions: capped, total, truncated: capped.length < total, scanned, scanTruncated };
  }

  /**
   * Turns a herdr `<workspace-label>:<tab-label>` handle (e.g. `upublish:1`)
   * into the exact live session it addresses, deterministically - the one-shot
   * path so a catch-up never guesses. herdr numbers nothing usefully in its
   * agent list (every agent is named "claude"), so we resolve the way the user
   * reads the handle: workspace by label, then tab by label (or a positional
   * index into the workspace's tabs when the part after the colon isn't a
   * label), then the tab's live Claude pane. Misses and ambiguity are returned
   * as data (the caller falls through to the on-disk index or presents
   * candidates); herdr being unreachable throws HerdrError (loud).
   */
  async function resolveHandle(options: ResolveHandleOptions): Promise<ResolveHandleResult> {
    const { workspaceId, currentSessionId } = options;
    const raw = options.handle.trim();
    if (raw === "" || raw === ":") {
      return { status: "not_found", reason: "invalid_handle", detail: `empty handle: ${JSON.stringify(options.handle)}` };
    }
    const colon = raw.indexOf(":");
    const labelPart = (colon === -1 ? raw : raw.slice(0, colon)).trim();
    const tabRaw = colon === -1 ? "" : raw.slice(colon + 1).trim();
    const tabPart = tabRaw === "" ? undefined : tabRaw;

    const workspaces = await client.workspaceList();
    let ws: Workspace | undefined;
    if (labelPart === "") {
      if (!workspaceId) {
        return {
          status: "not_found",
          reason: "no_current_workspace",
          detail: "handle has no workspace label and no current workspaceId was provided",
        };
      }
      ws = workspaces.find((w) => w.id === workspaceId);
      if (!ws) {
        return { status: "not_found", reason: "workspace", detail: `current workspace ${workspaceId} not found in herdr` };
      }
    } else {
      const match = matchWorkspace(workspaces, labelPart);
      if (match.kind === "none") {
        return { status: "not_found", reason: "workspace", detail: `no herdr workspace matched "${labelPart}"` };
      }
      if (match.kind === "many") {
        return {
          status: "ambiguous_workspace",
          query: labelPart,
          candidates: match.workspaces.map((w) => ({ workspaceId: w.id, label: w.label, cwd: w.cwd })),
        };
      }
      ws = match.workspace;
    }

    const wsLabel = ws.label ?? ws.id;
    const [tabs, panes] = await Promise.all([client.tabList(ws.id), client.paneList(ws.id)]);
    const wsTabs = tabs.filter((t) => t.workspaceId === ws!.id);
    const wsPanes = panes.filter((p) => p.workspaceId === ws!.id);
    const tabLabelById = new Map(wsTabs.map((t) => [t.id, t.label]));
    const claudePanes = wsPanes.filter((p) => p.agent === "claude" && UUID_RE.test(p.sessionId));

    let candidatePanes: Pane[];
    let matchedTabLabel: string | null;
    if (tabPart === undefined) {
      candidatePanes = claudePanes;
      matchedTabLabel = null;
    } else {
      const tab = matchTab(wsTabs, tabPart);
      if (!tab) {
        const labels = wsTabs.map((t) => t.label ?? "(unlabeled)").join(", ") || "none";
        return { status: "not_found", reason: "tab", detail: `no tab "${tabPart}" in workspace "${wsLabel}" (tabs: ${labels})` };
      }
      matchedTabLabel = tab.label;
      candidatePanes = claudePanes.filter((p) => p.tabId === tab.id);
      if (candidatePanes.length === 0) {
        const tabHasAnyPane = wsPanes.some((p) => p.tabId === tab.id);
        return {
          status: "not_found",
          reason: "no_claude_agent",
          detail: tabHasAnyPane
            ? `tab "${tab.label ?? tab.id}" in workspace "${wsLabel}" has no live Claude session`
            : `tab "${tab.label ?? tab.id}" in workspace "${wsLabel}" has no pane`,
        };
      }
    }

    if (candidatePanes.length === 0) {
      return { status: "not_found", reason: "no_claude_agent", detail: `workspace "${wsLabel}" has no live Claude session` };
    }
    if (candidatePanes.length > 1) {
      return {
        status: "ambiguous_pane",
        workspaceLabel: wsLabel,
        candidates: candidatePanes.map((p) => ({
          paneId: p.id,
          sessionId: p.sessionId,
          tabLabel: tabLabelById.get(p.tabId) ?? null,
          cwd: p.cwd,
        })),
      };
    }

    const pane = candidatePanes[0]!;
    return {
      status: "resolved",
      sessionId: pane.sessionId,
      cwd: pane.cwd,
      workspaceLabel: wsLabel,
      matchedTabLabel,
      handle: matchedTabLabel != null ? `${wsLabel}:${matchedTabLabel}` : wsLabel,
      live: true,
      isCurrent: currentSessionId !== undefined && pane.sessionId === currentSessionId,
    };
  }

  /**
   * Shared barricade for sessionOutline/sessionSearch/sessionRead: validates
   * `sessionId` as a UUID BEFORE any path is constructed (the security gate),
   * then stat-gates existence and size BEFORE any content
   * read (gate 2), then parses. Oversized is treated the same as absent -
   * the caller-visible contract is "can't retrieve this session," not a
   * distinct error code (see phase-1 discovery doc).
   */
  async function loadTurns(sessionId: string, cwd: string) {
    if (!UUID_RE.test(sessionId)) {
      throw new NecromancyError(
        "invalid_session_id",
        `session id is not a UUID: ${JSON.stringify(sessionId.slice(0, 80))}`,
      );
    }

    const sessionFile = join(projectsRoot, deriveSlug(cwd), `${sessionId}.jsonl`);
    let size: number;
    try {
      ({ size } = await stat(sessionFile));
    } catch (error) {
      if (isEnoent(error)) {
        throw new NecromancyError("session_not_found", `no session file for ${sessionId} in space ${cwd}`);
      }
      throw error;
    }
    if (size === 0 || size > maxSessionBytes) {
      throw new NecromancyError("session_not_found", `no session file for ${sessionId} in space ${cwd}`);
    }

    const text = await readSessionText(sessionFile);
    if (text === null) {
      throw new NecromancyError("session_not_found", `no session file for ${sessionId} in space ${cwd}`);
    }
    return parseTurns(text);
  }

  async function sessionOutline(args: {
    sessionId: string;
    cwd: string;
  } & OutlineOptions): Promise<OutlineResult> {
    const { sessionId, cwd, ...outlineOptions } = args;
    const turns = await loadTurns(sessionId, cwd);
    return outlineTurns(turns, { limit: maxOutlineEntries, ...outlineOptions });
  }

  async function sessionSearch(args: {
    sessionId: string;
    cwd: string;
    query: string;
  } & SearchOptions): Promise<SearchResult> {
    const { sessionId, cwd, query, ...searchOptions } = args;
    const turns = await loadTurns(sessionId, cwd);
    return searchTurns(turns, query, { limit: maxSearchMatches, ...searchOptions });
  }

  async function sessionRead(args: {
    sessionId: string;
    cwd: string;
    from: number;
    to?: number;
    maxBytes?: number;
  }): Promise<ReadResult> {
    const { sessionId, cwd, from, to, maxBytes } = args;
    const turns = await loadTurns(sessionId, cwd);
    return readTurns(turns, { from, to, maxBytes: maxBytes ?? maxReadBytes, maxSpan: maxReadSpan });
  }

  /**
   * The deterministic "always grab" anchor set for a session: the ask, final
   * state, commits/PRs, versions, files touched, errors, test results, and
   * user decisions - regex-extracted, so a catch-up summary can be grounded on
   * evidence rather than the model's recall. Same barricade as the readers.
   */
  async function sessionAnchors(args: { sessionId: string; cwd: string }): Promise<Anchors> {
    const turns = await loadTurns(args.sessionId, args.cwd);
    return extractAnchors(turns);
  }

  return {
    findSpaces,
    listSessions,
    searchAllSessions,
    resolveHandle,
    sessionOutline,
    sessionSearch,
    sessionRead,
    sessionAnchors,
  };
}
