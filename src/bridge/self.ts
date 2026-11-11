// self.ts: which agent the caller itself is.
//
// An agent that can't find itself in a list guesses, and on 2026-11-11 a
// lead on ska guessed wrong: it believed it was a CLI in a plain window,
// labelled an idle shell pane "lead", and started a second lead nobody could
// see. Every agent list now says which row is the caller, or that none is.
//
// The caller's own ids come from its environment, which the MCP server
// inherits: herdr sets HERDR_PANE_ID (`w3:p1B`), herdr-core HC_TERMINAL_ID
// (`t1h`). herdr wins when both are set, as in homeEngine: a herdr server
// started from a Herdr app terminal passes that terminal's id to its panes,
// and the innermost engine is the one the caller runs in.

import type { Engine } from "./route.js";

export interface Caller {
  /** Where the caller runs, or null when it is in neither engine. */
  engine: Engine | null;
  /** Its own id there: a herdr pane id or a herdr-core terminal address. */
  target: string | null;
}

export function callerOf(env: NodeJS.ProcessEnv = process.env): Caller {
  if (env.HERDR_PANE_ID) return { engine: "herdr", target: env.HERDR_PANE_ID };
  if (env.HC_TERMINAL_ID) return { engine: "core", target: env.HC_TERMINAL_ID };
  return { engine: null, target: null };
}

/** True when this agent row is the caller. Remote rows never are: the caller's ids are local. */
export function isCaller(row: { engine?: string; target?: string; machine?: string | null }, caller: Caller, host?: string): boolean {
  if (caller.engine === null || caller.target === null) return false;
  if (host !== undefined && host !== "" && host !== "local") return false;
  if (row.engine !== caller.engine) return false;
  if (row.machine) return false;
  return row.target === caller.target;
}

/** Marks the caller's row `you: true`, leaving every other row untouched. */
export function markCaller<T extends { engine?: string; target?: string; machine?: string | null }>(
  rows: T[],
  caller: Caller,
  host?: string,
): Array<T & { you?: true }> {
  return rows.map((row) => (isCaller(row, caller, host) ? { ...row, you: true as const } : row));
}

/** The top-level `you` a list carries: who the caller is, or why no row is. */
export function youSummary(
  rows: Array<{ engine?: string; target?: string; where?: string | null; workspaceId?: string; you?: true }>,
  caller: Caller,
  host?: string,
): Record<string, unknown> {
  if (caller.engine === null) {
    return {
      engine: null,
      target: null,
      note: "this session runs outside herdr and the Herdr app, so no row here is you",
    };
  }
  const own = rows.find((row) => row.you);
  if (own) {
    return { engine: caller.engine, target: caller.target, where: own.where ?? own.workspaceId ?? null };
  }
  const remote = host !== undefined && host !== "" && host !== "local";
  return {
    engine: caller.engine,
    target: caller.target,
    note: remote
      ? `you run on this machine (${caller.engine} ${caller.target}), not on ${host}`
      : `you are ${caller.engine === "core" ? "Herdr app terminal" : "herdr pane"} ${caller.target}, but it is missing from this list - check \`degraded\``,
  };
}
