// anchors.ts: the deterministic "always grab" set. A pure, regex-driven pass
// over a session's Turn[] that pulls the load-bearing facts a catch-up summary
// must never miss - the ask, the final state, git commits/PRs, version bumps,
// files touched, errors, test results, and user decisions - so the summary is
// grounded on extracted evidence instead of the model's gestalt read.
//
// Same discipline as reader.ts: pure functions, never throw on any input,
// every list deduped and bounded (count + length). Regex only - no model call,
// no I/O - so it is cheap and unit-testable against planted-needle fixtures.
//
// Precision over recall: patterns are anchored to real signals (git verbs,
// tool_use file_path fields, "N passed/failed", conventional-commit subjects)
// rather than greedy catch-alls, so a false anchor is rarer than a missed one.
//
// Recency over arrival: a catch-up cares where a session ENDED, so when a
// category overflows its cap the OLDEST items are dropped and the count of
// what was dropped is reported in `omitted` - never a silent cut. Every item
// carries the turn `index` it came from, so it can be read in context with
// one necromancy_read call.

import type { Turn } from "./reader.js";

/** One extracted fact and the turn it came from (a necromancy_read index). */
export interface AnchorItem {
  text: string;
  index: number;
}

/** The list-valued anchor categories, in output order. */
export const ANCHOR_CATEGORIES = ["commits", "prs", "versions", "files", "errors", "tests", "decisions"] as const;
export type AnchorCategory = (typeof ANCHOR_CATEGORIES)[number];

/** The canonical anchor set. Every field is bounded; lists are deduped. */
export interface Anchors {
  /** First real user ask - what the session set out to do. Slash commands
   * render as `/name args`; caveat/system boilerplate is skipped. */
  ask: AnchorItem | null;
  /** Last assistant text (fallback: last turn) - where it left off. */
  lastState: AnchorItem | null;
  /** git mutating ops + conventional-commit subjects + commit SHAs. */
  commits: AnchorItem[];
  /** PR / pull-request / issue references (#N). */
  prs: AnchorItem[];
  /** Semantic-version tokens (releases, bumps). Not harvested from
   * tool_result output, where dependency dumps would drown the real bumps. */
  versions: AnchorItem[];
  /** File paths from Edit/Write/Read/NotebookEdit tool inputs. */
  files: AnchorItem[];
  /** Error / failure signals. */
  errors: AnchorItem[];
  /** Test-result lines ("135 pass", "0 fail", "Ran N tests"). */
  tests: AnchorItem[];
  /** User directives / pivots - the decisions that steered the session. */
  decisions: AnchorItem[];
  /** Per category, how many older distinct items were dropped to fit the cap.
   * Only categories that lost something appear; `{}` means nothing was cut. */
  omitted: Partial<Record<AnchorCategory, number>>;
}

/** Max entries kept per list field - the NEWEST this many survive. */
export const MAX_ANCHORS_PER_CATEGORY = 12;
const ANCHOR_CLIP_CHARS = 200;

const GIT_OP_RE = /\bgit\s+(?:commit|merge|push|tag|revert|cherry-pick|rebase)\b[^\n"]*/gi;
const CONVENTIONAL_COMMIT_RE = /\b(?:feat|fix|chore|docs|refactor|test|perf|build|ci|style)(?:\([^)]*\))?!?:\s*[^\n"]+/gi;
const SHA_RE = /\bcommit\s+([0-9a-f]{7,40})\b/gi;
const PR_RE = /\b(?:PR|pull request|issue)\s*#?(\d+)\b|(?:^|\s)#(\d{1,6})\b/gi;
const VERSION_RE = /\bv?\d+\.\d+\.\d+(?:-[0-9a-z.]+)?\b/gi;
const FILE_FIELD_RE = /"(?:file_path|notebook_path|path)"\s*:\s*"([^"]+)"/g;
const ERROR_RE = /\b(?:error|exception|traceback|stack trace|panic|segfault|ENOENT|EACCES|cannot find|not found|failed to|undefined is not|null is not|unhandled)\b[^\n"]*/gi;
const TEST_RESULT_RE = /\b(?:\d+\s+(?:pass|passing|passed|fail|failing|failed)|Ran\s+\d+\s+tests?)\b[^\n"]*/gi;
const DECISION_CUE_RE = /\b(?:let's|instead|actually|do not|don't|we should|i want|i'd like|make sure|can we|change (?:it|this|that) to|rename|remove the|no[,.]|scrap|drop the|use \w+ not)\b/i;

// Harness-injected user records that carry no intent of the user's own.
const BOILERPLATE_USER_RE = /^\s*(?:<local-command-|<system-reminder>|<task-notification>|\[Request interrupted)/;
const COMMAND_NAME_RE = /<command-name>\s*([^<]*?)\s*<\/command-name>/;
const COMMAND_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/;

/** Whitespace-collapsed, ellipsis-terminated at ANCHOR_CLIP_CHARS. */
function clip(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  return collapsed.length <= ANCHOR_CLIP_CHARS ? collapsed : `${collapsed.slice(0, ANCHOR_CLIP_CHARS - 1)}…`;
}

/**
 * What a user turn actually asked, or null when it is harness boilerplate.
 * A slash-command invocation is recorded as `<command-name>` XML; it reads
 * back as the command line the user typed (`/herderp:ghost upublish:1`).
 */
export function userIntent(text: string): string | null {
  if (text.trim() === "" || BOILERPLATE_USER_RE.test(text)) return null;
  const command = COMMAND_NAME_RE.exec(text);
  if (command) {
    const args = COMMAND_ARGS_RE.exec(text)?.[1]?.trim() ?? "";
    return `${command[1]} ${args}`.trim();
  }
  return text;
}

/**
 * One category's distinct items, newest occurrence wins. A repeat moves the
 * item to the end (with its newer index) so the recency order stays honest;
 * Map preserves insertion order, so delete-then-set is the move.
 */
class Category {
  private readonly items = new Map<string, AnchorItem>();

  add(value: string, index: number): void {
    const text = clip(value);
    if (text === "") return;
    const key = text.toLowerCase();
    this.items.delete(key);
    this.items.set(key, { text, index });
  }

  /** Run a global regex over text, feeding each match's payload into add. */
  harvest(text: string, re: RegExp, index: number): void {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      // A capture group (e.g. the PR number / SHA) is the payload when present;
      // otherwise the whole match. Zero-width guard keeps the loop finite.
      this.add((m[1] ?? m[2] ?? m[0]).trim(), index);
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }

  /** The newest MAX_ANCHORS_PER_CATEGORY items (chronological) + how many were dropped. */
  newest(): { kept: AnchorItem[]; dropped: number } {
    const all = [...this.items.values()];
    const dropped = Math.max(0, all.length - MAX_ANCHORS_PER_CATEGORY);
    return { kept: all.slice(dropped), dropped };
  }
}

/**
 * Extract the canonical anchor set from a session's turns. Total over any
 * Turn[] (including []), never throws. Single pass; every list bounded.
 */
export function extractAnchors(turns: Turn[]): Anchors {
  const cats = Object.fromEntries(ANCHOR_CATEGORIES.map((c) => [c, new Category()])) as Record<
    AnchorCategory,
    Category
  >;

  let ask: AnchorItem | null = null;
  let lastState: AnchorItem | null = null;
  let lastAny: AnchorItem | null = null;

  for (const turn of turns) {
    const { text, index } = turn;
    if (text.trim() === "") continue;
    lastAny = { text: clip(text), index };

    if (turn.role === "user") {
      const intent = userIntent(text);
      if (intent !== null) {
        if (ask === null) ask = { text: clip(intent), index };
        if (DECISION_CUE_RE.test(intent)) cats.decisions.add(intent, index);
      }
    }
    if (turn.role === "text") lastState = { text: clip(text), index };

    cats.commits.harvest(text, GIT_OP_RE, index);
    cats.commits.harvest(text, CONVENTIONAL_COMMIT_RE, index);
    cats.commits.harvest(text, SHA_RE, index);
    cats.prs.harvest(text, PR_RE, index);
    if (turn.role !== "tool_result") cats.versions.harvest(text, VERSION_RE, index);
    cats.errors.harvest(text, ERROR_RE, index);
    cats.tests.harvest(text, TEST_RESULT_RE, index);

    // Any tool_use may carry a path field; Bash/etc. simply have none, so
    // scanning them all is precise without an explicit tool allowlist.
    if (turn.role === "tool_use") cats.files.harvest(text, FILE_FIELD_RE, index);
  }

  const lists = {} as Record<AnchorCategory, AnchorItem[]>;
  const omitted: Partial<Record<AnchorCategory, number>> = {};
  for (const category of ANCHOR_CATEGORIES) {
    const { kept, dropped } = cats[category].newest();
    lists[category] = kept;
    if (dropped > 0) omitted[category] = dropped;
  }

  return { ask, lastState: lastState ?? lastAny, ...lists, omitted };
}
