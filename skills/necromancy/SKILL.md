---
name: necromancy
description: Reads past Claude Code sessions on this machine to catch the user up — "what have we been doing in this project", "go through the recent sessions", "what did the last session do", "where did we discuss X", "did we already try Y". Digests a project's recent sessions in one call, searches session content across every project, resolves a herdr handle like upublish:1 to its live session, and reads any session's turns in place. Reading only; it never revives or relaunches a session. Not for other agents' or editors' sessions (Cursor, aider, Codex), editor autosaves/swap files or unsaved changes, git stashes or uncommitted work, how-to questions about `claude --resume`, continuing the current conversation, or herdr pane/tab/workspace management (use the herdr_* tools).
---

# necromancy

Catch the user up on prior Claude Code work by reading session transcripts in place (`~/.claude/projects/<slug>/<uuid>.jsonl`). Every tool is read-only. Pick the entry point by what the user knows, read only what matters, and be honest about every cap.

## 0. Know which session you are

Run `echo "$CLAUDE_CODE_SESSION_ID $HERDR_WORKSPACE_ID"` in Bash first. Pass the session id as `currentSessionId` and the workspace id as `workspaceId` wherever a tool takes them. Only the Bash value is current; the MCP server's own env is fixed at spawn and goes stale across `/clear` and resume. This is what keeps you from summarizing yourself.

## 1. Pick the entry point

| The user… | Call |
|---|---|
| wants recent work in a project: "catch me up", "what have we been doing", "go through the recent sessions", or names nothing | `necromancy_digest({ cwd, currentSessionId })`. Use the current project's cwd unless they named another project. |
| knows **what** happened but not where: "the session where we fixed the flaky login test" | `necromancy_search_all({ query })`. Add `cwd` to stay in one project, `regex: true` for a pattern. |
| gives a herdr handle: `upublish:1`, `:2`, or a bare `2` (= `:2`, a tab in the current space) | `necromancy_resolve({ handle, workspaceId, currentSessionId })`, then step 2. |
| names a project but you don't know its exact cwd | `necromancy_find_spaces({ query: "<name>" })`, then `necromancy_digest` on the match. |
| gives a session id (a UUID) | Read it directly (step 3) with the cwd it lives in. |

- **Digest** returns the newest sessions, each with its ask, last state, and newest anchors. That's usually enough to answer a "what's been happening" question outright. Read in depth only the session(s) the answer hinges on.
- **Choosing "the previous session":** skip `current` (that's you), and treat `catchUp: true` as a hint that the session only caught up on others (it called necromancy tools and edited nothing). Check its `lastState` before passing over it. Headless runs (automated SDK reviews and pipelines) are left out of the digest and counted in `headlessSkipped`. Pass `includeHeadless: true` only if the user asks about them.
- **`find_spaces` matches:** zero means say "nothing matched '<name>'" and never guess a cwd. More than one means list them and ask. With no query it returns only the most recently active spaces (capped), not every project.

## 2. After `necromancy_resolve`

- `status: "resolved"`: if `isCurrent` is true, that is this very session. Say so and offer the previous one instead. Otherwise take `sessionId` + `cwd` to step 3. If `matchedTabLabel` differs from what the user typed, say which tab it matched.
- `ambiguous_workspace` / `ambiguous_pane`: present the `candidates` and ask. Never pick one silently.
- `not_found`: no live tab addresses it, so the session may be dead. If you know the space's cwd, `necromancy_digest` (or `necromancy_list_sessions`) shows its sessions newest first. With `reason: "workspace"` you have no cwd, so try `necromancy_find_spaces({ query: <label> })`. Tell the user the live lookup missed and that you fell back to disk. A herdr tab number and the Nth file on disk are unrelated, so never present an on-disk pick as "tab N".

## 3. Read one session

1. **`necromancy_anchors({ sessionId, cwd })`** gives the load-bearing facts: ask, last state, commits, PRs, versions, files, errors, tests, decisions. Each item is `{text, index}`, and every list keeps its newest items. A non-empty `omitted` means older items were dropped. Treat anchors as a checklist the summary must account for, and confirm the ones you rely on by reading their `index`.
2. **`necromancy_outline({ sessionId, cwd, view: "spine" })`** lists just the user's asks and the assistant's prose. It's the cheapest way to see the story. Drop `view` (or use `filter: "tool_use"`) when the tool-call ledger matters.
3. **`necromancy_search({ sessionId, cwd, query })`** jumps to the turns that mention a keyword or symptom.
4. **`necromancy_read({ sessionId, cwd, from, to, toolResultChars: 500 })`** reads the turns that matter, with tool output clipped. Leave `toolResultChars` off only when one specific output (a stack trace, a test log) is the point.

## Be honest about caps and outages

- **Most responses are bounded; say when something was cut.**

  | Signal | Meaning | What to do |
  |---|---|---|
  | `truncated` | More matched than came back | Narrow the query. |
  | `nextOffset` | The outline has more entries | Page forward if you need them. |
  | `omitted` (anchors, digest) | Older items were dropped | Don't treat the list as the whole story. |
  | `scanTruncated` (search_all) | Older sessions were never opened | "No hits" is not proof it didn't happen. Narrow with `cwd`. |

  Never say "here's the whole session" when a cap cut what came back.
- **herdr down:** `necromancy_resolve` fails with a typed error; fall back to disk. `find_spaces` and `list_sessions` still list everything with `degraded: true`, and labels, live status, and handles are unknown, so say that. `digest`, `search_all`, `anchors`, and the readers never touch herdr.
- **Nothing found:** an unknown space returns empty lists; a missing session returns `session_not_found`. Say plainly what wasn't found.

Claude Code sessions only. No other agent CLI is supported.
