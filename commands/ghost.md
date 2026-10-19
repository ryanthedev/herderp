---
description: Catch up on past Claude Code work in this herdr space - the previous session by default, or a named agent, space, handle (upublish:1), or session id. Plain summary, current state, open threads, and questions to resume. Reading only; never revives a session.
argument-hint: "[space | <space>:<tab> | session-id] - or nothing for the previous session"
---

Catch the user up on a past Claude Code session. Reading only - never revive or relaunch anything.

Follow the **necromancy** skill's procedure (invoke it with the Skill tool if it isn't loaded): it owns identity (step 0), entry points, resolve handling, the reading loop, and honest handling of caps and outages. This command only decides **which** session(s) from `$ARGUMENTS` and **how** to report.

## Pick the target from `$ARGUMENTS`

Read loosely, in any order:

| `$ARGUMENTS` | Do this |
|---|---|
| Empty | The previous session in the current project: `necromancy_digest({ cwd: <current project>, currentSessionId })`, then take the newest entry that did real work. `catchUp: true` is a hint that a session only caught up; check its `lastState` before skipping it. If the user's ask was broader ("what have we been doing"), report on the digest as a whole. |
| A session id (UUID) | Read that session. If it isn't in the current project, say "no session `<id>` found here", ask which project it belongs to, and stop. Never substitute another session. |
| A handle (`upublish:1`, `:2`, or a bare `2`) | Resolve it per the skill. Always say which rung answered: the live tab, or the on-disk fallback. |
| A name (`herderp`) | `necromancy_find_spaces({ query })`, then `necromancy_digest` on the matched space. One recent session means read it; several means show the digest and ask which. |

## Report

Write plain prose, no theatrics:

- **Summary:** one tight paragraph on what the session set out to do and what got done.
- **Current state:** where it ended (finished, or left mid-air).
- **Open threads:** a bulleted list of unfinished work.
- **Questions:** 3–5 to ask the user to pick the work back up.

Account for every anchor that matters: each commit, PR, version, file, and decision should appear or be consciously judged not worth mentioning. If anchors came back with `omitted`, say the session ran longer than the anchors show. Cite turn indexes for load-bearing claims, like `[#849]`, so any of them can be pulled with one `necromancy_read`. Quote short verbatim snippets rather than paraphrasing what the session said.
