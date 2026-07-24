// reader.ts: pure jsonl-text -> structured Turn[] and deterministic
// outline/search/read views over them. Sibling to preview.ts (same "never
// crash on malformed input" discipline) but addressable at content-block
// granularity instead of whole-message granularity, so an agent can jump to
// one specific tool_use or thinking block by stable index.
//
// Line shapes handled (see preview.ts header for the verified jsonl schema):
//   {"type":"user","message":{"content":...},"isSidechain":...}
//   {"type":"assistant","message":{"content":[...]},"isSidechain":...}
// `content` may be a plain string or an array of content blocks. Records with
// `isSidechain: true`, any type other than user/assistant, and unparseable
// lines are all skipped - never a crash.
//
// One Turn per addressable content block, not per message: a user text, an
// assistant `thinking`, an assistant `text`, each `tool_use`, each
// `tool_result`. `index` is a 0-based ordinal over included Turns in file
// order - the pointer every outline/search hit and read range is addressed
// by.

export type TurnRole = "user" | "thinking" | "text" | "tool_use" | "tool_result";

/** One addressable content block. `tool` is set for tool_use/tool_result. */
export interface Turn {
  index: number;
  role: TurnRole;
  tool?: string;
  text: string;
}

export interface OutlineEntry {
  index: number;
  role: TurnRole;
  tool?: string;
  preview: string;
}

export interface OutlineResult {
  entries: OutlineEntry[];
  total: number;
  nextOffset: number | null;
}

export interface SearchMatch {
  index: number;
  role: TurnRole;
  tool?: string;
  snippet: string;
}

export interface SearchResult {
  matches: SearchMatch[];
  truncated: boolean;
}

export interface FullEntry {
  index: number;
  role: TurnRole;
  tool?: string;
  text: string;
}

export interface ReadResult {
  entries: FullEntry[];
  truncated: boolean;
}

export const DEFAULT_MAX_OUTLINE_ENTRIES = 200;
export const DEFAULT_MAX_SEARCH_MATCHES = 50;
export const DEFAULT_MAX_READ_BYTES = 64 * 1024;
export const DEFAULT_MAX_READ_SPAN = 200;

const OUTLINE_CLIP_CHARS = 100;
const SNIPPET_CONTEXT_CHARS = 60;
const SNIPPET_MAX_CHARS = 160;

/** One trimmed jsonl line -> its object form, or null for empty/malformed/non-object lines. */
function parseRecord(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null; // malformed line: skip, never crash
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Text form of a tool_use's structured input. `input` is always a value that
 * came from JSON.parse (a parsed jsonl block) - never circular, a function, or
 * a BigInt - so JSON.stringify is total here and returns undefined only for a
 * missing input, which we normalize to "".
 */
function stringifyToolInput(input: unknown): string {
  return JSON.stringify(input) ?? "";
}

/**
 * Flatten one message's `content` (bare string or block array) into ordered
 * Turns, given the role to use for plain text blocks (`"user"` or `"text"`)
 * and a running `toolNameByUseId` map so a later `tool_result` block can
 * recover the tool name its originating `tool_use` carried.
 */
function turnsFromContent(
  content: unknown,
  textRole: "user" | "text",
  toolNameByUseId: Map<string, string>,
): Array<Omit<Turn, "index">> {
  if (typeof content === "string") {
    return content === "" ? [] : [{ role: textRole, text: content }];
  }
  if (!Array.isArray(content)) return [];

  const turns: Array<Omit<Turn, "index">> = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    const type = block.type;
    if (type === "text" && typeof block.text === "string") {
      turns.push({ role: textRole, text: block.text });
    } else if (type === "thinking" && typeof block.thinking === "string") {
      turns.push({ role: "thinking", text: block.thinking });
    } else if (type === "tool_use") {
      const name = typeof block.name === "string" ? block.name : "unknown";
      if (typeof block.id === "string") toolNameByUseId.set(block.id, name);
      turns.push({ role: "tool_use", tool: name, text: stringifyToolInput(block.input) });
    } else if (type === "tool_result") {
      const useId = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
      const name = (useId && toolNameByUseId.get(useId)) ?? "unknown";
      turns.push({ role: "tool_result", tool: name, text: toolResultText(block.content) });
    }
  }
  return turns;
}

/** tool_result content is itself a string or an array of {type:"text"} blocks. */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block): block is Record<string, unknown> => isRecord(block) && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("\n");
  }
  return "";
}

/** jsonl text -> ordered role-tagged Turns. Never throws. */
export function parseTurns(text: string): Turn[] {
  const toolNameByUseId = new Map<string, string>();
  const turns: Turn[] = [];

  for (const line of text.split("\n")) {
    const record = parseRecord(line);
    if (!record) continue;
    if (record.isSidechain === true) continue;

    const message = record.message;
    if (!isRecord(message)) continue;

    let pending: Array<Omit<Turn, "index">>;
    if (record.type === "user") {
      pending = turnsFromContent(message.content, "user", toolNameByUseId);
    } else if (record.type === "assistant") {
      pending = turnsFromContent(message.content, "text", toolNameByUseId);
    } else {
      continue; // meta record (summary, ai-title, mode, ...): not a turn
    }

    for (const turn of pending) {
      turns.push({ ...turn, index: turns.length });
    }
  }
  return turns;
}

/** Whitespace-collapsed, at most `maxChars` (ellipsis-terminated when cut). */
function clip(raw: string, maxChars: number): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  return collapsed.length <= maxChars ? collapsed : `${collapsed.slice(0, maxChars - 1)}…`;
}

export interface OutlineOptions {
  offset?: number;
  limit?: number;
  filter?: TurnRole;
}

/** One clipped line per entry, paged by offset/limit, optionally role-filtered. */
export function outlineTurns(turns: Turn[], options: OutlineOptions = {}): OutlineResult {
  const { offset = 0, limit = DEFAULT_MAX_OUTLINE_ENTRIES, filter } = options;
  const filtered = filter ? turns.filter((turn) => turn.role === filter) : turns;
  const start = Math.max(0, offset);
  const page = filtered.slice(start, start + Math.max(0, limit));

  const entries: OutlineEntry[] = page.map((turn) => ({
    index: turn.index,
    role: turn.role,
    ...(turn.tool !== undefined && { tool: turn.tool }),
    preview: clip(turn.text, OUTLINE_CLIP_CHARS),
  }));

  const end = start + page.length;
  return { entries, total: filtered.length, nextOffset: end < filtered.length ? end : null };
}

export interface SearchOptions {
  limit?: number;
  regex?: boolean;
}

/** One turn's match position, or null when the turn doesn't match. */
interface TurnMatch {
  at: number;
  length: number;
}

/**
 * `query` as a case-insensitive RegExp, or null when it is not a valid
 * pattern. The two callers disagree about what invalid means - searchTurns
 * falls back to a literal substring search, core.searchAllSessions raises a
 * typed error - so the decision stays with them rather than in here.
 */
export function compileSearchPattern(query: string): RegExp | null {
  try {
    return new RegExp(query, "i");
  } catch {
    return null;
  }
}

/** First hit of `pattern` (when given) or of `query` as a case-insensitive substring. */
function findMatch(text: string, query: string, pattern: RegExp | null): TurnMatch | null {
  if (pattern) {
    const found = pattern.exec(text);
    return found ? { at: found.index, length: found[0].length } : null;
  }
  if (query === "") return null;
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  return at === -1 ? null : { at, length: query.length };
}

/** A bounded window of `text` around `matchIndex`, whitespace-collapsed. */
function buildSnippet(text: string, matchIndex: number, matchLength: number): string {
  const start = Math.max(0, matchIndex - SNIPPET_CONTEXT_CHARS);
  const end = Math.min(text.length, matchIndex + matchLength + SNIPPET_CONTEXT_CHARS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return clip(`${prefix}${text.slice(start, end)}${suffix}`, SNIPPET_MAX_CHARS);
}

/** Case-insensitive lexical (or, if `regex`, pattern) match over entry text. */
export function searchTurns(turns: Turn[], query: string, options: SearchOptions = {}): SearchResult {
  const { limit = DEFAULT_MAX_SEARCH_MATCHES, regex = false } = options;
  // invalid pattern: fall back to a literal substring search, never crash
  const pattern = regex ? compileSearchPattern(query) : null;

  const matches: SearchMatch[] = [];
  let truncated = false;

  for (const turn of turns) {
    const match = findMatch(turn.text, query, pattern);
    if (!match) continue;

    if (matches.length >= limit) {
      truncated = true;
      break;
    }
    matches.push(toMatch(turn, match));
  }

  return { matches, truncated };
}

function toMatch(turn: Turn, match: TurnMatch): SearchMatch {
  return {
    index: turn.index,
    role: turn.role,
    ...(turn.tool !== undefined && { tool: turn.tool }),
    snippet: buildSnippet(turn.text, match.at, match.length),
  };
}

/** How one whole session answers a search: how many of its turns matched, and
 * the first one as the single representative hit. */
export interface TurnMatchSummary {
  /** Every matching turn is counted - unlike searchTurns there is no cap here,
   * because the count is the point (one session collapses to one entry). */
  matchCount: number;
  /** The first matching turn (index/role/tool + bounded snippet), or null when none did. */
  first: SearchMatch | null;
}

/**
 * Same matching rule as searchTurns, summarized per session instead of per
 * turn - what cross-session search needs, where a session that mentions the
 * query forty times is still one result carrying `matchCount: 40`.
 */
export function summarizeTurnMatches(
  turns: Turn[],
  query: string,
  options: { regex?: boolean } = {},
): TurnMatchSummary {
  const pattern = options.regex ? compileSearchPattern(query) : null;

  let matchCount = 0;
  let first: SearchMatch | null = null;
  for (const turn of turns) {
    const match = findMatch(turn.text, query, pattern);
    if (!match) continue;
    matchCount += 1;
    if (!first) first = toMatch(turn, match); // only the first hit is ever rendered
  }
  return { matchCount, first };
}

export interface ReadOptions {
  from: number;
  to?: number;
  maxBytes?: number;
  /** Server-side span cap; not part of the plan's caller-facing shorthand but required to satisfy DW-1.4/DW-1.6 - see phase-1 discovery doc. */
  maxSpan?: number;
}

/** Verbatim content of entries [from,to], span- and byte-capped. */
export function readTurns(turns: Turn[], options: ReadOptions): ReadResult {
  const { from, to = from, maxBytes = DEFAULT_MAX_READ_BYTES, maxSpan = DEFAULT_MAX_READ_SPAN } = options;

  if (turns.length === 0 || to < from) return { entries: [], truncated: false };

  const lastIndex = turns.length - 1;
  const clampedFrom = Math.min(Math.max(from, 0), lastIndex);
  const clampedTo = Math.min(Math.max(to, 0), lastIndex);

  const spanCappedTo = Math.min(clampedTo, clampedFrom + maxSpan - 1);
  const spanTruncated = spanCappedTo < clampedTo;

  const entries: FullEntry[] = [];
  let bytes = 0;
  let byteTruncated = false;
  for (let i = clampedFrom; i <= spanCappedTo; i++) {
    const turn = turns[i]!;
    const remaining = maxBytes - bytes;
    if (remaining <= 0) {
      byteTruncated = true;
      break;
    }
    const entryBytes = Buffer.byteLength(turn.text, "utf8");
    if (entryBytes <= remaining) {
      bytes += entryBytes;
      entries.push({
        index: turn.index,
        role: turn.role,
        ...(turn.tool !== undefined && { tool: turn.tool }),
        text: turn.text,
      });
      continue;
    }
    // This single entry alone would blow the byte cap: include a
    // byte-safe-truncated slice of it instead of either exceeding the cap
    // or silently dropping it (never dump, but never lose the pointer
    // either - DW-1.6's "never exceeds the byte cap" is a hard invariant).
    entries.push({
      index: turn.index,
      role: turn.role,
      ...(turn.tool !== undefined && { tool: turn.tool }),
      text: truncateToBytes(turn.text, remaining),
    });
    byteTruncated = true;
    break;
  }

  return { entries, truncated: spanTruncated || byteTruncated };
}

/** Largest prefix of `text` whose UTF-8 byte length is <= `maxBytes`. */
function truncateToBytes(text: string, maxBytes: number): string {
  let buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return text;
  buf = buf.subarray(0, maxBytes);
  // Fix up a multi-byte char split at the boundary by trimming back to the
  // largest valid UTF-8 prefix. First drop trailing continuation bytes
  // (10xxxxxx), then drop the orphaned lead byte (>= 0xC0) they belonged to -
  // otherwise toString would decode it as U+FFFD (3 bytes) and blow the cap.
  let end = buf.byteLength;
  while (end > 0 && (buf[end - 1]! & 0b1100_0000) === 0b1000_0000) end--;
  if (end > 0 && buf[end - 1]! >= 0xc0) end--;
  return buf.subarray(0, end).toString("utf8");
}
