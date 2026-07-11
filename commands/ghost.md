---
description: Read a past Claude Code session in this herdr space and get a clear catch-up summary, plus questions to resume it. Point it at an agent/space name and/or a session id, or nothing for the previous session. Never revives; reading only.
argument-hint: "[agent/space name] [session-id] — or nothing for the previous session"
---

Read a past Claude Code session in this herdr space and catch the user up on it. Reading only — never revive or relaunch the session.

Drive the **necromancy** skill's reading flow (`necromancy_find_spaces` → `necromancy_list_sessions` → `necromancy_anchors` → `necromancy_outline` / `necromancy_search` / `necromancy_read`) — that skill owns the procedure and the honest handling of caps; follow it. Read only the turns that matter, not every one of a long session's turns.

**Resolve the target in one shot — never dump the whole graveyard.** `necromancy_find_spaces` lists *every* project on the machine (there can be hundreds), so calling it bare blows the tool-result token cap. Two rules:
- If you already know the exact cwd — the **current project** you're running in — skip `find_spaces` entirely and call `necromancy_list_sessions({ space: <cwd> })` directly.
- Otherwise pass a `query` so it returns only the matching space(s): `necromancy_find_spaces({ query: "<name>" })`. It comes back newest-active first with `total`/`truncated`; if `truncated` is true, say so and narrow rather than implying you saw them all.

**Argument shorthand — `<space>:<index>`.** `$ARGUMENTS` may pack the space and a session position into one `name:n` token:
- `herderp:3` → space matching **herderp**, then the **3rd** session (1-based, newest-first) from `necromancy_list_sessions`. Resolve the space with `find_spaces({ query: "herderp" })`, list its sessions, pick the 3rd, and go straight to anchors + read — no back-and-forth.
- `:3` (no name) → the 3rd session in the **current** space.
- A bare number `3` → likewise the 3rd session in the current space.
- A bare name `herderp` (no colon) → resolve the space, then present its sessions to pick from (unless only one exists).
- If the index is out of range, say how many sessions the space actually has rather than guessing.

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
