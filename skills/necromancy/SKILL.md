---
name: necromancy
description: Finds, previews, and reads a previous Claude Code agent session recorded on disk for a project or workspace ("space") — reading a past session's actual turns (search, outline, verbatim) in place to get up to speed on what it did. Use when the user wants to find or look up a lost or previous Claude Code session or agent; asks what past sessions exist for a project/workspace/cwd; or wants to know what happened in a past session, catch up on prior work, see what was tried or discussed before, or search/read old session content. Not for starting a brand-new Claude Code session from scratch, or general herdr workspace/pane/tab management with no session-reading intent (use the herderp MCP tools directly). Claude Code sessions only (unsupported for other agent CLIs in v1).
---

# necromancy

Read a Claude Code session the user has lost track of, in place — get up to speed on what it did without relaunching it. Five MCP tools back this: `necromancy_find_spaces`, `necromancy_list_sessions` (resolve and enumerate sessions) and `necromancy_outline`, `necromancy_search`, `necromancy_read` (the reading path) — this skill is the conversation that drives them in the right order and reads their results honestly.

## Reading a session (get up to speed on prior work)

What's usually wanted is a past session's content — what was tried, what broke, what a stack trace said, which files were touched — read in place.

- **Trigger cues:** "what did that session do", "catch me up on the last session", "what did we try before for X", "did a past session already look at this", "find where session X discussed Y" — anything asking about a prior session's *content*.

**The loop:**
1. **Resolve a target to a space.** The user may point at a space by workspace id, a label, a project cwd, something that names a session directly, or nothing at all.
   - Call `necromancy_find_spaces` first, always — it costs nothing and gives you everything needed to match or to show candidates.
   - **No target given:** present the returned spaces (cwd, label, session count, last activity) and ask which one.
   - **A target given:** match it case-insensitively against each space's `cwd`, `label`, and `workspaceId`.
     - **Zero matches:** say so plainly ("nothing matched '<target>'") and fall back to presenting the full space list — never guess a cwd that wasn't returned.
     - **One match:** proceed with that space's cwd.
     - **More than one match:** list the matches and ask the user to pick — never silently choose the first one.
   - If the target looks like it's naming a *session* directly (a UUID, or a description that only makes sense as a session, not a project) rather than a space, resolve whatever cwd you can and treat the target as a session filter once you have the list.
   - Then call `necromancy_list_sessions({ space: <cwd> })` and, unless a session was already named, present the sessions newest-first with their preview, message count, and whether each is live in herdr, so the user can pick one.
2. **Outline first**, not read first — call `necromancy_outline({ sessionId, cwd })` to see the shape of the session (role, tool name, a clipped preview per entry) before pulling any turn in full. Use `filter` (e.g. `tool_use`) to scan just the tool-call ledger when that's what's relevant.
3. **Search when you have a keyword or symptom** — call `necromancy_search({ sessionId, cwd, query })` to jump straight to the turns that mention it, each result carrying the `index` needed to read it in full.
4. **Read only the turns that matter** — call `necromancy_read({ sessionId, cwd, from, to })` with the specific index (or index range) an outline/search hit pointed at, rather than reading the whole session start to end.

**Honor `truncated`/`nextOffset` honestly.** Every response is capped on both count and bytes. A `truncated: true` on search means more matched than were returned — narrow the query, don't assume you've seen every hit. A `nextOffset` on outline means there are more entries — page forward if the summary you're building needs them. Never tell the user "here's the whole session" when a cap cut what came back; say what you actually saw and that more exists.

## Degraded environments

Both failure modes below are expected, recoverable states, not bugs — never let either surface as a raw tool error or stack trace.

- **herdr isn't running:** this only blocks the space tools (`necromancy_find_spaces`/`necromancy_list_sessions`), which will fail with a clear, typed error — tell the user herdr needs to be running for those, and stop. The reading tools (`necromancy_outline`/`necromancy_search`/`necromancy_read`) never call herdr and work regardless.
- **No session history on this machine, or the given session doesn't exist:** the on-disk lookups (`necromancy_find_spaces`, `necromancy_list_sessions`) return empty lists (not errors) when `~/.claude/projects` doesn't exist; the reading tools instead surface a typed error for a missing/invalid session. Either way, tell the user plainly what wasn't found rather than implying something went wrong.

## Scope (v1)

Claude Code sessions only — no other agent CLI kind is supported yet.
