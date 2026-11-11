// reply.ts: an agent's last reply of its own, for anything that quotes what
// a session last said (the watcher's stop summaries, the team roster).

import type { Necromancy } from "./core.js";

/**
 * The agent's last reply of its own. sessionAnchors().lastState falls back to
 * the last turn of ANY role when there is no assistant prose (an agent that
 * stops before replying), and a user prompt or tool output must never be
 * quoted as the agent's reply - so the turn's role is checked.
 */
export async function lastReply(necromancy: Necromancy, sessionId: string, cwd: string): Promise<string | undefined> {
  const { lastState } = await necromancy.sessionAnchors({ sessionId, cwd });
  if (!lastState) return undefined;
  const { entries } = await necromancy.sessionRead({ sessionId, cwd, from: lastState.index, maxBytes: 1 });
  return entries[0]?.role === "text" ? lastState.text : undefined;
}
