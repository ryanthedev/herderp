// sessions.ts: which Claude Code session is running in a core terminal.
//
// herdr reports a pane's Claude session id itself; herdr-core does not. The
// join (verified 2026-11-08 on t3s): the terminal's foreground pid is the
// `claude` process, and Claude Code writes ~/.claude/sessions/<pid>.json with
// that process's `sessionId`. The file is rewritten when the session changes
// (/clear, /resume), so reading it on demand gives the current session.
//
// Limits, stated rather than guessed around:
//   - remote terminals (`ska/t7`): the pid and the sessions folder are on the
//     other machine, so the answer is null;
//   - a foreground that is not Claude Code: null, so a reused pid owned by
//     some other program can never borrow a dead session's id;
//   - a file whose own `pid` disagrees with its name: null.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { CoreTerminal } from "./types.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The Claude session id running in a terminal, or null with no guess. */
export type SessionLookup = (terminal: CoreTerminal) => Promise<string | null>;

/** True when the terminal's foreground looks like Claude Code. */
export function isClaudeTerminal(terminal: CoreTerminal): boolean {
  if (terminal.app === "claude-code") return true;
  const argv0 = terminal.foreground?.argv[0];
  return argv0 !== undefined && basename(argv0) === "claude";
}

export function createSessionLookup(sessionsDir = join(homedir(), ".claude", "sessions")): SessionLookup {
  return async (terminal) => {
    if (terminal.machine !== null || terminal.foreground === null) return null;
    if (!isClaudeTerminal(terminal)) return null;
    const pid = terminal.foreground.pid;
    let text: string;
    try {
      text = await readFile(join(sessionsDir, `${pid}.json`), "utf8");
    } catch {
      return null; // no file: not started yet, or not a Claude that writes one
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as { pid?: unknown; sessionId?: unknown };
    if (record.pid !== pid) return null;
    return typeof record.sessionId === "string" && UUID_RE.test(record.sessionId) ? record.sessionId : null;
  };
}
