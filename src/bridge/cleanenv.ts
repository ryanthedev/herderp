// cleanenv.ts: start agents without another Claude session's markers.
//
// A Herdr window or herdr-core launched from a Claude shell hands that
// shell's environment to every terminal it starts. Verified 2026-11-08:
// a 0.1.19 core installed from a Claude Bash kept the updater's
// environment, and every new terminal got CLAUDE_CODE_CHILD_SESSION=1. A
// Claude started with that marker saves no transcript, so it can't be
// resumed, adopted, or read by necromancy. A window relaunch doesn't help:
// new terminals take the holder's environment, not the caller's.
//
// So herderp launches agents through `env -u ...`, which strips the markers
// whatever the core carries. The terminal runs argv through the user's login
// shell (`zsh -lic "$@"`), so their profile still applies before `env`.
// HC_TERMINAL_ID and HC_SCOPE are NOT stripped: herdr-core sets them per
// terminal, and they are the new agent's own identity.

/** Per-session markers a Claude Code process passes to its children, plus a leaked test home. */
export const CLAUDE_SESSION_MARKERS: readonly string[] = [
  "CLAUDECODE",
  "CLAUDE_PID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_EFFORT",
  "HERDR_APP_HOME",
];

/** `["claude", "-c"]` -> `["env", "-u", "CLAUDECODE", ..., "claude", "-c"]`. */
export function cleanLaunch(argv: readonly string[]): string[] {
  return ["env", ...CLAUDE_SESSION_MARKERS.flatMap((name) => ["-u", name]), ...argv];
}
