// absent.ts: telling "this engine isn't installed here" apart from "this
// engine is down". A machine with only herdr, or only the Herdr app, must not
// report every answer as degraded: an engine that isn't there was never part
// of the answer. One that is installed but not answering still degrades.

import { CoreError } from "../core/types.js";
import { HerdrError } from "../herdr/types.js";

/** True when the error means the engine's program isn't on this machine (ENOENT on spawn). */
export function isNotInstalled(error: unknown): boolean {
  if (error instanceof CoreError) return error.code === "not_installed";
  if (error instanceof HerdrError && error.code === "spawn_failed") {
    const cause = (error as { cause?: unknown }).cause;
    return typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "ENOENT";
  }
  return false;
}

/** ENOENT from a spawn: the program isn't installed. */
export function isEnoentCause(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "ENOENT";
}
