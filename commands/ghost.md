---
description: Read a past Claude Code session in this herdr space and get a clear catch-up summary, plus questions to resume it. Point it at an agent/space name and/or a session id, or nothing for the previous session. Never revives; reading only.
argument-hint: "[agent/space name] [session-id] — or nothing for the previous session"
---

Read a past Claude Code session in this herdr space and catch the user up on it. Reading only — never revive or relaunch the session.

Drive the **necromancy** skill's reading flow (`necromancy_resolve` / `necromancy_find_spaces` → `necromancy_list_sessions` → `necromancy_anchors` → `necromancy_outline` / `necromancy_search` / `necromancy_read`) — that skill owns the procedure and the honest handling of caps; follow it. Read only the turns that matter, not every one of a long session's turns.

**Know who you are first.** Before resolving anything, get the running session's own id and herdr location from a **fresh Bash env** — `echo "$CLAUDE_CODE_SESSION_ID $HERDR_WORKSPACE_ID"`. Pass the session id as `currentSessionId` and the workspace id as `workspaceId` into `necromancy_resolve` and `necromancy_list_sessions`. Do **not** rely on the MCP server to know this — its env is baked at spawn and goes stale across `/clear`/resume, so only the Bash value is trustworthy. This is what lets you say "that's this very session" instead of accidentally reading yourself (the bug this command is built to avoid).

**Resolve the target in one shot — never dump the whole graveyard.** `necromancy_find_spaces` lists *every* project on the machine (there can be hundreds), so calling it bare blows the tool-result token cap. Two rules:
- If you already know the exact cwd — the **current project** you're running in — skip `find_spaces` entirely and call `necromancy_list_sessions({ cwd })` directly.
- Otherwise pass a `query` so it returns only the matching space(s): `necromancy_find_spaces({ query: "<name>" })`. It comes back newest-active first with `total`/`truncated`; if `truncated` is true, say so and narrow rather than implying you saw them all.

**Argument shorthand — `<space>:<n>` is a herdr agent address, resolved by a precedence ladder.** In herdr, `upublish:1` means "the upublish workspace, the agent in the tab labeled `1`" — a *live* agent, not "the Nth session file on disk". Resolve it that way, in this order, and **always tell the user which rung answered**:

1. **Handle rung (live).** Call `necromancy_resolve({ handle: "<space>:<n>", workspaceId, currentSessionId })`.
   - `status:"resolved"` → you have the exact `sessionId` + `cwd`. Go straight to anchors + read. Note in your reply what it resolved to, e.g. "resolved `upublish:1` → the live agent in tab `1`, session a5e2…". If `matchedTabLabel` differs from what the user typed (you typed `:1`, it matched the tab labeled `2` positionally), **say so**.
   - `status:"ambiguous_workspace"` / `"ambiguous_pane"` → present the `candidates` and ask which; never silently pick one.
   - `status:"not_found"` → fall through to rung 2 (the session is likely **dead** — no live tab addresses it).
2. **On-disk index rung (dead sessions).** Call `necromancy_list_sessions({ cwd, currentSessionId })` and take the **Nth session newest-first, skipping any with `current:true`** (that's this ghost session — never the target). Announce this: "no live tab `1` in upublish — read the 1st past session on disk, 3f9c…".
3. If the index is out of range, say how many sessions the space actually has rather than guessing.

Other forms:
- `:3` / bare number `3` → no workspace label: resolve against the **current** space (pass `workspaceId`); dead-session fallback is the 3rd session in the current space (minus `current`).
- A bare name `herderp` (no colon) → resolve the space, then present its sessions to pick from (unless only one exists).

**If a resolved or listed session is the current one** (`isCurrent:true` from resolve, or `current:true` in a listing), never summarize it — say "that's this very session you're running in" and offer the previous one instead (the newest listed session that isn't `current`).

**If herdr is down**, `necromancy_resolve` errors (it needs herdr) but `necromancy_list_sessions` still returns the on-disk sessions with `degraded:true` and `live` all false — use it, and say live/handle status is unknown rather than implying nothing is running.

**Grab the anchors first.** Once you've picked the session, call `necromancy_anchors` — it deterministically extracts the load-bearing facts (the ask, final state, commits, PRs, version bumps, files touched, errors, test results, user decisions) by regex, so you don't have to hope a skim catches them. Treat the anchor set as a checklist the summary must account for: every commit, PR, version, file, and decision it surfaces should show up in your catch-up (or be consciously judged not worth mentioning) — that's how we make sure nothing important is missed. Use `outline`/`search`/`read` to confirm and quote the anchors in context; don't just parrot them.

Pick which session to read from the arguments — `$ARGUMENTS` — read loosely, any order, or empty:
- A **session id** — a UUID. If present, read *that* session directly and skip the guessing. If the given UUID isn't found on disk anywhere, say so plainly ("no session `<id>` found") and stop — don't invent one.
- An **agent / space name** — a herdr agent name, workspace label, or cwd (the agent name usually *is* the space). Match it to a space; ambiguous → list and ask.
- **Nothing** — the most recent session in the current space that isn't the live one you're running in ("the previous session").

Then deliver a clear, plain-language catch-up — normal and genuinely useful, no theatrics or gimmicks:

- **Summary** — one tight paragraph: what the session was about and what got done.
- **Current state** — the last concrete state (finished, or left mid-air).
- **Open threads** — bulleted unfinished work.
- **Questions** — 3–5 worth asking the user to pick the work back up.

Quote short verbatim snippets for anything load-bearing — don't invent or paraphrase what the session actually said.
