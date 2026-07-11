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

import type { Turn } from "./reader.js";

/** The canonical anchor set. Every field is bounded; lists are deduped. */
export interface Anchors {
  /** First user turn - what the session set out to do. */
  ask: string | null;
  /** Last assistant text (fallback: last turn) - where it left off. */
  lastState: string | null;
  /** git mutating ops + conventional-commit subjects + commit SHAs. */
  commits: string[];
  /** PR / pull-request / issue references (#N). */
  prs: string[];
  /** Semantic-version tokens (releases, bumps). */
  versions: string[];
  /** File paths from Edit/Write/Read/NotebookEdit tool inputs. */
  files: string[];
  /** Error / failure signals. */
  errors: string[];
  /** Test-result lines ("135 pass", "0 fail", "Ran N tests"). */
  tests: string[];
  /** User directives / pivots - the decisions that steered the session. */
  decisions: string[];
}

/** Max entries kept per list field. Excess is dropped (see `truncated`). */
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

/** Whitespace-collapsed, ellipsis-terminated at ANCHOR_CLIP_CHARS. */
function clip(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  return collapsed.length <= ANCHOR_CLIP_CHARS ? collapsed : `${collapsed.slice(0, ANCHOR_CLIP_CHARS - 1)}…`;
}

/** Push deduped, clipped, capped. Mutates `into`; ignores empties/dupes. */
function collect(into: string[], seen: Set<string>, value: string): void {
  if (into.length >= MAX_ANCHORS_PER_CATEGORY) return;
  const v = clip(value);
  if (v === "") return;
  const key = v.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  into.push(v);
}

/** Run a global regex over text, feeding each whole match into `collect`. */
function harvest(into: string[], seen: Set<string>, text: string, re: RegExp): void {
  if (into.length >= MAX_ANCHORS_PER_CATEGORY) return;
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    // A capture group (e.g. the PR number / SHA) is the payload when present;
    // otherwise the whole match. Non-global-safe guard: break on zero-width.
    collect(into, seen, (m[1] ?? m[2] ?? m[0]).trim());
    if (m.index === re.lastIndex) re.lastIndex++;
    if (into.length >= MAX_ANCHORS_PER_CATEGORY) break;
  }
}

/**
 * Extract the canonical anchor set from a session's turns. Total over any
 * Turn[] (including []), never throws. Single pass; every list bounded.
 */
export function extractAnchors(turns: Turn[]): Anchors {
  const commits: string[] = [];
  const prs: string[] = [];
  const versions: string[] = [];
  const files: string[] = [];
  const errors: string[] = [];
  const tests: string[] = [];
  const decisions: string[] = [];
  const seen = {
    commits: new Set<string>(),
    prs: new Set<string>(),
    versions: new Set<string>(),
    files: new Set<string>(),
    errors: new Set<string>(),
    tests: new Set<string>(),
    decisions: new Set<string>(),
  };

  let ask: string | null = null;
  let lastState: string | null = null;
  let lastAny: string | null = null;

  for (const turn of turns) {
    const text = turn.text;
    if (ask === null && turn.role === "user" && text.trim() !== "") ask = clip(text);
    if (turn.role === "text" && text.trim() !== "") lastState = clip(text);
    if (text.trim() !== "") lastAny = clip(text);

    harvest(commits, seen.commits, text, GIT_OP_RE);
    harvest(commits, seen.commits, text, CONVENTIONAL_COMMIT_RE);
    harvest(commits, seen.commits, text, SHA_RE);
    harvest(prs, seen.prs, text, PR_RE);
    harvest(versions, seen.versions, text, VERSION_RE);
    harvest(errors, seen.errors, text, ERROR_RE);
    harvest(tests, seen.tests, text, TEST_RESULT_RE);

    // Any tool_use may carry a path field; Bash/etc. simply have none, so
    // scanning them all is precise without an explicit tool allowlist.
    if (turn.role === "tool_use") {
      harvest(files, seen.files, text, FILE_FIELD_RE);
    }
    if (turn.role === "user" && DECISION_CUE_RE.test(text)) {
      collect(decisions, seen.decisions, text);
    }
  }

  return {
    ask,
    lastState: lastState ?? lastAny,
    commits,
    prs,
    versions,
    files,
    errors,
    tests,
    decisions,
  };
}
