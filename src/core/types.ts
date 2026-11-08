// Seam types for herdr-core (`hc`), the engine the Herdr desktop app runs its
// terminals in, and for the app's own layout CLI (`herdr-app`). Shapes are
// trimmed from the live API (`hc schema`, herdr-core 0.1.18) to what herderp
// reads - the raw objects carry more, and unknown fields are ignored.

/** A core terminal's status word (OSC 7501). `null` when the program never
 * reported one - a plain shell, or an agent still booting. */
export type CoreStatus = "idle" | "working" | "blocked" | "done" | "error";

export interface CoreTerminal {
  /** `t7` here, `ska/t7` on another machine. The stable way to address it. */
  address: string;
  /** Unique among live terminals when set (`hc run --name`). */
  name: string | null;
  /** "live" or "finished". */
  state: string;
  /** What reported itself, e.g. "claude-code"; "" when nothing reported. */
  app: string;
  status: CoreStatus | null;
  /** blocked only: permission | question | auth, when the program said. */
  blockedKind: string | null;
  /** The program's own one-line note about what it is doing. */
  message: string;
  title: string;
  /** Goes up each time the status leaves `working`. */
  turn: number;
  /** Where it runs now (the foreground's folder), else its launch folder. */
  cwd: string;
  /** The foreground process: its pid and argv. Null once finished. */
  foreground: { pid: number; argv: string[]; cwd: string } | null;
  labels: Record<string, string>;
  /** The terminal that started it (sub-agents), else null. */
  parent: string | null;
  /** Herdr.app's `herdr.space` / `herdr.tab` labels: where the window shows it. */
  spaceId: string | null;
  tabId: string | null;
  /** hc's `where` label, "<space> / <tab>", when Herdr shows it. */
  where: string | null;
  /** The machine it runs on: null for this one. */
  machine: string | null;
}

export interface CoreMachine {
  name: string;
  state: string;
}

export interface CoreListing {
  terminals: CoreTerminal[];
  machines: CoreMachine[];
}

export interface CoreReadResult {
  text: string;
  /** False when part of what was asked for may be missing. */
  complete: boolean;
  /** "screen", "history" or "stitched". */
  how: string;
  /** Why only the screen came back ("working", "blocked", "error"). */
  why: string | null;
}

export interface CoreSendResult {
  turn: number;
  /** Whether it went `working` within a few seconds; null when it doesn't report. */
  started: boolean | null;
  status: string | null;
  wait: CoreWaitResult | null;
}

export interface CoreWaitResult {
  terminal: string;
  /** False on timeout: a check-in, still running. */
  ended: boolean;
  /** status | exit | output | timeout | not_started | message */
  reason: string;
  status: string | null;
  turn: number;
  exitCode: number | null;
}

export interface CoreInterruptResult {
  /** stopped | exited | still_working | unknown */
  outcome: string;
  key: string;
}

// --- herdr-app (the window) -----------------------------------------------

export interface AppTerminalRef {
  terminal: string;
  pane: string;
  status: string | null;
  app: string | null;
  name: string | null;
}

export interface AppTab {
  id: string;
  name: string;
  active: boolean;
  terminals: AppTerminalRef[];
}

export interface AppSpace {
  id: string;
  name: string;
  folder: string | null;
  /** null for this machine. */
  machine: string | null;
  active: boolean;
  tabs: AppTab[];
}

/**
 * Typed error for every CoreClient failure: hc or herdr-app missing or not
 * answering, a JSON-RPC error (its `data.kind` becomes the code, e.g.
 * `not_found`), unparseable output, or a timeout. Same contract as HerdrError
 * so the tool harness renders `[code] message` for both.
 */
export class CoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CoreError";
    this.code = code;
  }
}
