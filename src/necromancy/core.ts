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
import { parseSessionPreview } from "./preview.js";
import { extractAnchors, type Anchors } from "./anchors.js";
import {
  DEFAULT_MAX_OUTLINE_ENTRIES,
  DEFAULT_MAX_READ_BYTES,
  DEFAULT_MAX_READ_SPAN,
  DEFAULT_MAX_SEARCH_MATCHES,
  outlineTurns,
  parseTurns,
  readTurns,
  searchTurns,
  type OutlineOptions,
  type OutlineResult,
  type ReadResult,
  type SearchOptions,
  type SearchResult,
} from "./reader.js";

export type { Turn, TurnRole, OutlineEntry, SearchMatch, FullEntry } from "./reader.js";
export type { Anchors } from "./anchors.js";

/**
 * Claude Code's project-directory slug: each `/` and `.` in the cwd becomes
 * `-`. A deliberate character map over the raw string - NOT path
 * normalization, which would collapse the dots the slug must preserve
 * (`/a/.b` -> `-a--b`). Reversal is lossy (`-` may mean `/`, `.`, or a
 * literal `-`), which is why findSpaces recovers cwds from live workspaces
 * or session lines instead of un-slugging.
 */
export function deriveSlug(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

export type NecromancyErrorCode = "invalid_session_id" | "session_not_found";

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

export interface SessionInfo {
  id: string;
  cwd: string;
  mtime: number;
  live: boolean;
  preview: string;
  messageCount: number;
}

export type Necromancy = ReturnType<typeof createNecromancy>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_MAX_SESSION_BYTES = 32 * 1024 * 1024;
export const DEFAULT_MAX_SPACES = 40;

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

  async function listSessions(cwd: string): Promise<SessionInfo[]> {
    const files = await scanSessionFiles(join(projectsRoot, deriveSlug(cwd)));
    if (files.length === 0) return [];

    // One agentList per call; a live sessionId with no on-disk file simply
    // never matches - disk drives the list (DW-3.5). A HerdrError here
    // propagates typed (loud) rather than silently marking everything dead.
    const liveIds = new Set((await client.agentList()).map((agent) => agent.sessionId));

    const sessions: SessionInfo[] = [];
    for (const file of files) {
      if (!withinSizeGate(file)) continue;
      const text = await readSessionText(file.path);
      if (text === null) continue;
      const parsed = parseSessionPreview(text);
      if (!parsed) continue; // malformed jsonl: skip, never crash
      sessions.push({
        id: file.id,
        cwd,
        mtime: file.mtimeMs,
        live: liveIds.has(file.id),
        preview: parsed.preview,
        messageCount: parsed.messageCount,
      });
    }
    return sessions; // scanSessionFiles already ordered newest first
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

  return { findSpaces, listSessions, sessionOutline, sessionSearch, sessionRead, sessionAnchors };
}
