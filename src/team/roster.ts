// roster.ts: the pure half of herdr_team - who is on a team, who reports to
// whom, and what needs a look. No I/O: core.ts gathers each member's facts
// (labels, screen text, last reply, transcript time) and this file turns them
// into a tree and flags.
//
// The team rule is the user's ROLES.md: a space is a team, `role=orchestrator`
// leads, `role=proxy` is infrastructure. This file adds only the level below
// that rule: `reports-to=<terminal>` makes the tree, `job=<name>` says what a
// member is on, `retired=<successor>` marks one that handed off. Teams started
// by hand before these keys existed used `<project>.reports-to` and
// `<project>=<job>` (plenary, 2026-11-11); those are read too, never written.
//
// Screen parsing here is heuristic by nature (it reads what a person would
// see); every such result is named as a heuristic where it is reported.

export const LABEL_REPORTS_TO = "reports-to";
export const LABEL_JOB = "job";
export const LABEL_ROLE = "role";
export const LABEL_RETIRED = "retired";
export const LABEL_SPACE = "herdr.space";

/** Context use at or past this is time to hand off (the team's 60% rule). */
export const CONTEXT_LIMIT_PCT = 60;
export const DEFAULT_STALL_MS = 600_000;
export const LAST_MESSAGE_CHARS = 300;
const DETAIL_LINES = 12;
/** How far up from the bottom a live choice list can start. */
const PROMPT_TAIL_LINES = 10;

const LEGACY_SUFFIX = ".reports-to";

/** The label key that carries this terminal's reports-to, or null. */
export function reportsToKey(labels: Record<string, string>): string | null {
  if (labels[LABEL_REPORTS_TO]) return LABEL_REPORTS_TO;
  const legacy = Object.keys(labels)
    .filter((key) => key.endsWith(LEGACY_SUFFIX) && labels[key])
    .sort();
  return legacy[0] ?? null;
}

export function reportsToOf(labels: Record<string, string>): string | null {
  const key = reportsToKey(labels);
  return key === null ? null : labels[key]!;
}

/** `job`, else the legacy `<project>=<job>` beside a `<project>.reports-to`, else a bare `<project>=<job>` named after nothing we can know (null). */
export function jobOf(labels: Record<string, string>): string | null {
  if (labels[LABEL_JOB]) return labels[LABEL_JOB]!;
  const key = reportsToKey(labels);
  if (key !== null && key !== LABEL_REPORTS_TO) {
    const project = key.slice(0, -LEGACY_SUFFIX.length);
    if (labels[project]) return labels[project]!;
  }
  return null;
}

/**
 * True when the labels put this terminal on a team: a role (other than the
 * infrastructure `proxy`), a job, or a reports-to. This is the bar recycle
 * and cleanup hold a terminal to. `retired` is deliberately not on the list:
 * it says what happened to a member, it does not make one - a bare
 * `retired` label on a person's shell once got that shell closed (verifier,
 * 2026-11-11).
 */
export function isTeamMember(labels: Record<string, string>): boolean {
  const role = labels[LABEL_ROLE];
  return reportsToKey(labels) !== null || Boolean(labels[LABEL_JOB]) || (Boolean(role) && role !== "proxy");
}

// --- screen reading (heuristics) ---------------------------------------------

/**
 * Context use from Claude Code's pane footer (`  <glyph> Opus 5.5 · <glyph> medium · <glyph> 16%`;
 * the glyphs are private-use icon characters), read from the bottom of the
 * screen. Null when no such line is there.
 */
export function parseContextPct(screen: string): number | null {
  const lines = screen.split("\n");
  for (let i = lines.length - 1, seen = 0; i >= 0 && seen < FOOTER_LINES; i--) {
    const line = lines[i]!.trimEnd();
    if (line.trim() === "") continue;
    seen++;
    const match = /·[^\d·]*(\d{1,3})%\s*$/.exec(line);
    if (match) {
      const pct = Number(match[1]);
      return pct <= 100 ? pct : null;
    }
  }
  return null;
}

/** The footer is the last thing on a Claude Code screen; looking further up reads the agent's own output. */
const FOOTER_LINES = 4;

const RULE_RE = /^[─━]{20,}\s*$/;

/**
 * Text sitting in Claude Code's composer, unsent: the lines between the two
 * rules at the bottom of the screen, after the `❯` prompt mark. Null when the
 * composer is empty or not on screen. Plain screen text can't tell typed text
 * from the greyed suggestion Claude Code shows there after a turn (seen live
 * 2026-11-11: six of plenary's stopped sessions "had a draft", all of them
 * suggestions), so callers treat it as a draft only while the agent works -
 * Claude Code shows no suggestion then.
 */
export function parseDraft(screen: string): string | null {
  const lines = screen.split("\n").map((line) => line.trimEnd());
  let bottom = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!RULE_RE.test(lines[i]!)) continue;
    if (bottom === -1) {
      bottom = i;
      continue;
    }
    const body = lines.slice(i + 1, bottom);
    if (body.length === 0 || body.length > 40 || !/^\s*❯/.test(body[0]!)) return null;
    const text = [body[0]!.replace(/^\s*❯\s?/, ""), ...body.slice(1).map((line) => line.replace(/^ {1,2}/, ""))]
      .join("\n")
      .replace(/ /g, " ")
      .trim();
    return text === "" ? null : text;
  }
  return null;
}

/**
 * What a blocked agent is asking, as shown: the lines above its numbered
 * choices (`1. Yes`), which for a permission prompt include the command.
 * `permission` is true when such a yes/no list is on screen. Falls back to
 * the last lines of the screen.
 */
export function parseBlockedPrompt(screen: string): { permission: boolean; detail: string } {
  const lines = screen.split("\n").map((line) => line.trimEnd());
  const optionOne = /^\s*(?:[❯>]\s*)?1\.\s/;
  let yes = -1;
  // The live choice list is the last one on screen and sits near the bottom;
  // an older "1. Yes" further up, or one followed by another list, is history.
  for (let i = lines.length - 1, seen = 0; i >= 0 && seen < PROMPT_TAIL_LINES; i--) {
    if (lines[i]!.trim() === "") continue;
    seen++;
    if (!optionOne.test(lines[i]!)) continue;
    if (/^\s*(?:[❯>]\s*)?1\.\s+Yes\b/.test(lines[i]!)) yes = i;
    break;
  }
  const end = yes === -1 ? lines.length : yes;
  const picked: string[] = [];
  for (let i = end - 1; i >= 0 && picked.length < DETAIL_LINES; i--) {
    const line = lines[i]!.replace(/^[\s│╭╰─╮╯]+|[\s│╭╰─╮╯]+$/g, "");
    if (line !== "") picked.unshift(line);
  }
  return { permission: yes !== -1, detail: picked.join("\n") };
}

/** Heuristic: one of the reply's last two lines asks something (`...? (y/n)` and a sign-off line after it count). */
export function endsWithQuestion(text: string | null): boolean {
  if (!text) return false;
  const tail = text
    .trim()
    .split("\n")
    .filter((line) => line.trim() !== "")
    .slice(-2);
  return tail.some((line) => /\?\s*(?:\([^)]{0,20}\))?["')\]*_`]*\s*$/.test(line));
}

// --- members, flags, tree ----------------------------------------------------

export type Flag = "blocked" | "permission" | "question" | "draft" | "unstarted" | "maybe-draft" | "stalled" | "context" | "orphan" | "retired";

/** Worst first: the order of the "needs attention" view. */
const FLAG_ORDER: readonly Flag[] = ["permission", "blocked", "question", "draft", "unstarted", "stalled", "context", "maybe-draft", "orphan", "retired"];

/** Flags that mean someone should look now; `retired` and `orphan` alone are bookkeeping. */
const ATTENTION_FLAGS: ReadonlySet<Flag> = new Set(["permission", "blocked", "question", "draft", "unstarted", "stalled", "context", "maybe-draft"]);

/** One member's facts as core.ts gathered them. */
export interface MemberFacts {
  target: string;
  labels: Record<string, string>;
  status: string | null;
  blockedKind: string | null;
  message: string;
  /** Turns it has finished; 0 with status idle means its first prompt never ran. */
  turn: number;
  createdMs: number | null;
  tabId: string | null;
  tabLabel: string | null;
  /** The pane's screen text; null when it could not be read. */
  screen: string | null;
  /** The agent's last reply in full; null when unknown. */
  lastReply: string | null;
  /** When its transcript last moved (ms); null when unknown. */
  activityAt: number | null;
}

export interface Member {
  target: string;
  role: string | null;
  job: string | null;
  tabId: string | null;
  tabLabel: string | null;
  status: string | null;
  blockedKind: string | null;
  message: string;
  contextPct: number | null;
  lastMessage: string | null;
  /** Text in its composer. Unsent typing, or - once it has stopped - possibly Claude Code's own greyed suggestion. */
  composer: string | null;
  reportsTo: string | null;
  reportsToOutside: boolean;
  flags: Flag[];
  you?: true;
  reports: Member[];
}

export interface Attention {
  target: string;
  tabLabel: string | null;
  flags: Flag[];
  why: string;
  /** The text to act on: the prompt on screen, the question, or the typed text. */
  detail: string | null;
  /** The agent's own status note; for a permission prompt it carries the whole command. */
  message: string;
}

export interface Roster {
  leader: string | null;
  tree: Member[];
  attention: Attention[];
  infrastructure: Member[];
  warnings: string[];
}

export interface RosterOptions {
  now: number;
  stallMs?: number;
  /** Every live terminal's address, on any space: tells "outside" from "gone". */
  live: ReadonlySet<string>;
  you?: string | null;
  /** Also list stopped members with composer text as `maybe-draft` (it may be a suggestion). */
  drafts?: boolean;
}

function truncate(text: string, max: number): string {
  const flat = text.trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function describe(facts: MemberFacts, options: RosterOptions): { member: Member; attention: Attention | null } {
  const { labels } = facts;
  const stallMs = options.stallMs ?? DEFAULT_STALL_MS;
  const contextPct = facts.screen === null ? null : parseContextPct(facts.screen);
  const reportsTo = reportsToOf(labels);
  const flags = new Set<Flag>();
  const why: string[] = [];
  let detail: string | null = null;

  if (facts.status === "blocked") {
    const prompt = facts.screen === null ? null : parseBlockedPrompt(facts.screen);
    if (facts.blockedKind === "permission" || prompt?.permission) {
      flags.add("permission");
      why.push("waiting on a permission prompt");
    } else {
      flags.add("blocked");
      why.push(facts.blockedKind ? `blocked (${facts.blockedKind})` : "blocked");
    }
    detail = prompt?.detail || null;
  }
  const stopped = facts.status === "idle" || facts.status === "done";
  if (facts.blockedKind === "question" || (stopped && endsWithQuestion(facts.lastReply))) {
    flags.add("question");
    why.push("stopped with a question (heuristic: its last reply ends in one)");
    detail ??= facts.lastReply ? truncate(facts.lastReply, LAST_MESSAGE_CHARS) : null;
  }
  const composer = facts.screen === null || facts.status === "blocked" ? null : parseDraft(facts.screen);
  // Only while it works: once it stops, the composer may hold Claude Code's own greyed suggestion.
  if (composer !== null && facts.status === "working") {
    flags.add("draft");
    why.push("text typed in its composer while it works, not sent");
    detail ??= truncate(composer, LAST_MESSAGE_CHARS);
  } else if (composer !== null && options.drafts) {
    flags.add("maybe-draft");
    why.push("text in its composer - typed and never sent, or Claude Code's own greyed suggestion (screen text can't tell)");
    detail ??= truncate(composer, LAST_MESSAGE_CHARS);
  }
  if (facts.status === "idle" && facts.turn === 0) {
    flags.add("unstarted");
    why.push("idle and has never run a turn - its first prompt did not arrive");
  }
  if (facts.status === "working" && facts.activityAt !== null && options.now - facts.activityAt > stallMs) {
    flags.add("stalled");
    why.push(`working, but its transcript has not moved for ${Math.round((options.now - facts.activityAt) / 60_000)} min`);
  }
  if (contextPct !== null && contextPct >= CONTEXT_LIMIT_PCT) {
    flags.add("context");
    why.push(`context at ${contextPct}% - time to hand off (herdr_team{action:'recycle'})`);
  }
  if (reportsTo !== null && !options.live.has(reportsTo)) flags.add("orphan");
  if (labels[LABEL_RETIRED]) flags.add("retired");

  const ordered = FLAG_ORDER.filter((flag) => flags.has(flag));
  const member: Member = {
    target: facts.target,
    role: labels[LABEL_ROLE] || null,
    job: jobOf(labels),
    tabId: facts.tabId,
    tabLabel: facts.tabLabel,
    status: facts.status,
    blockedKind: facts.blockedKind,
    message: facts.message,
    contextPct,
    lastMessage: facts.lastReply ? truncate(facts.lastReply, LAST_MESSAGE_CHARS) : null,
    composer: composer === null ? null : truncate(composer, LAST_MESSAGE_CHARS),
    reportsTo,
    reportsToOutside: false,
    flags: ordered,
    ...(options.you === facts.target ? { you: true as const } : {}),
    reports: [],
  };
  const needsLook = ordered.some((flag) => ATTENTION_FLAGS.has(flag));
  return {
    member,
    attention: needsLook ? { target: facts.target, tabLabel: facts.tabLabel, flags: ordered, why: why.join("; "), detail, message: facts.message } : null,
  };
}

/** True when following reports-to from `start` comes back to it. */
function inCycle(start: string, parentOf: Map<string, string | null>): boolean {
  const seen = new Set<string>();
  let at = parentOf.get(start) ?? null;
  while (at !== null && !seen.has(at)) {
    if (at === start) return true;
    seen.add(at);
    at = parentOf.get(at) ?? null;
  }
  return false;
}

/**
 * A space's members as a tree by reports-to. A member whose reports-to names
 * nobody on this team (none, another space, gone, or a loop) is a root.
 * `role=proxy` rows are returned apart and never lead (ROLES.md rule 3).
 */
export function buildRoster(facts: MemberFacts[], options: RosterOptions): Roster {
  const age = (f: MemberFacts) => f.createdMs ?? Number.MAX_SAFE_INTEGER;
  const sorted = [...facts].sort((a, b) => age(a) - age(b) || a.target.localeCompare(b.target));
  const described = new Map(sorted.map((f) => [f.target, describe(f, options)]));
  const team = sorted.filter((f) => f.labels[LABEL_ROLE] !== "proxy");
  const onTeam = new Set(team.map((f) => f.target));
  const parentOf = new Map(team.map((f) => [f.target, reportsToOf(f.labels)]));
  const warnings: string[] = [];

  const orchestrators = team.filter((f) => f.labels[LABEL_ROLE] === "orchestrator" && !f.labels[LABEL_RETIRED]);
  const leader = orchestrators[0]?.target ?? null;
  if (orchestrators.length > 1) {
    warnings.push(`more than one role=orchestrator (${orchestrators.map((f) => f.target).join(", ")}); the oldest, ${leader}, leads`);
  }

  const roots: Member[] = [];
  for (const f of team) {
    const { member } = described.get(f.target)!;
    const parent = parentOf.get(f.target) ?? null;
    if (parent !== null && parent !== f.target && onTeam.has(parent) && !inCycle(f.target, parentOf)) {
      described.get(parent)!.member.reports.push(member);
      continue;
    }
    if (parent !== null && !onTeam.has(parent) && options.live.has(parent)) member.reportsToOutside = true;
    if (parent !== null && onTeam.has(parent)) warnings.push(`${f.target}'s reports-to chain loops; shown at the top`);
    roots.push(member);
  }
  roots.sort((a, b) => Number(b.target === leader) - Number(a.target === leader));

  const attention = sorted
    .map((f) => described.get(f.target)!.attention)
    .filter((a): a is Attention => a !== null)
    .sort((a, b) => FLAG_ORDER.indexOf(a.flags[0]!) - FLAG_ORDER.indexOf(b.flags[0]!));

  return {
    leader,
    tree: roots,
    attention,
    infrastructure: sorted.filter((f) => f.labels[LABEL_ROLE] === "proxy").map((f) => described.get(f.target)!.member),
    warnings,
  };
}

/** `root` and everyone under it by reports-to, root first. Loops are walked once. */
export function subtreeOf(members: Array<{ target: string; labels: Record<string, string> }>, root: string): string[] {
  const reports = new Map<string, string[]>();
  for (const m of members) {
    const parent = reportsToOf(m.labels);
    if (parent !== null) reports.set(parent, [...(reports.get(parent) ?? []), m.target]);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [root];
  while (queue.length > 0) {
    const at = queue.shift()!;
    if (seen.has(at)) continue;
    seen.add(at);
    out.push(at);
    queue.push(...(reports.get(at) ?? []));
  }
  return out;
}

// --- launch lines --------------------------------------------------------------

/** The script `loginLaunch` hands the shell: become the program, so no shell stays in between. */
const EXEC_ARGS = 'exec "$@"';
const PROFILE_SHELLS: ReadonlySet<string> = new Set(["zsh", "bash"]);

/**
 * Runs a launch line through the user's login + interactive shell, so the
 * new session gets the environment their own sessions have. herdr-core
 * starts a `terminal.run` program directly, with the core's environment and
 * no shell profile: verified 2026-11-11, sessions started with `hc run` had
 * no ENGRAM_ADDR (set in the interactive profile) and Engram failed in every
 * one with "name resolver error". Only zsh and bash are wrapped (`-lic` means
 * the same in both); any other shell leaves the line as it is.
 */
export function loginLaunch(argv: readonly string[], shell: string | undefined): string[] {
  const name = (shell ?? "").split("/").pop() ?? "";
  if (!shell || !PROFILE_SHELLS.has(name)) return [...argv];
  return [shell, "-lic", EXEC_ARGS, name, ...argv];
}

/** A launch line without its wrappers: `zsh -lic 'exec "$@"' zsh env -u A claude ...` -> `claude ...`. */
export function stripEnvWrapper(argv: readonly string[]): string[] {
  let line = [...argv];
  if (line[1] === "-lic" && line[2] === EXEC_ARGS) line = line.slice(4);
  if (line[0] !== "env") return line;
  let i = 1;
  while (i < line.length) {
    if (line[i] === "-u" && i + 1 < line.length) i += 2;
    else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(line[i]!)) i += 1;
    else break;
  }
  return line.slice(i);
}

/**
 * The prompt goes after `--` for Claude Code: `--add-dir` and `--mcp-config`
 * take several values and would swallow a prompt placed right after them
 * (verifier, 2026-11-11: the member started with no task), and a prompt
 * starting with `-` would be read as a flag. Other agents' CLIs are not
 * known to take `--`, so their line is left as it is.
 */
export function withPrompt(line: readonly string[], prompt: string, isClaude: boolean): string[] {
  return isClaude ? [...line, "--", prompt] : [...line, prompt];
}

/** The plugin set of a Claude launch line: its `--settings` and `--plugin-dir` flags, in order. */
export const PLUGIN_FLAGS: readonly string[] = ["--settings", "--plugin-dir"];
/** What a successor keeps from its predecessor's launch line: the plugin set plus how it runs. */
export const CARRIED_FLAGS: readonly string[] = [...PLUGIN_FLAGS, "--model", "--permission-mode", "--add-dir", "--mcp-config", "--effort"];
const CARRIED_SWITCHES: readonly string[] = ["--dangerously-skip-permissions"];

/** Pulls the named value flags (`--flag value` or `--flag=value`) out of a launch line, in order. */
export function extractFlags(argv: readonly string[], names: readonly string[] = PLUGIN_FLAGS, switches: readonly string[] = []): string[] {
  const out: string[] = [];
  const line = stripEnvWrapper(argv);
  for (let i = 1; i < line.length; i++) {
    const arg = line[i]!;
    if (switches.includes(arg)) out.push(arg);
    else if (names.includes(arg) && i + 1 < line.length) out.push(arg, line[++i]!);
    else if (names.some((name) => arg.startsWith(`${name}=`))) out.push(arg);
  }
  return out;
}

export function carriedFlags(argv: readonly string[]): string[] {
  return extractFlags(argv, CARRIED_FLAGS, CARRIED_SWITCHES);
}
