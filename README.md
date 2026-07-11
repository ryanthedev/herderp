# herderp

A Claude Code plugin: a stdio **MCP server** wrapping the [`herdr`](https://github.com/ryanthedev/herderp) CLI with curated one-shot tools, plus **session necromancy** — find and read a previous Claude Code agent session from a herdr "space."

## What it does

- **Curated herdr tools** — one-shot MCP calls over the `herdr` CLI instead of hand-typing it: `agent list/get/read/wait`, `workspace create/focus`, `pane run/close`, `session list`.
- **Necromancy** — point at a space (a herdr workspace id, label, project cwd, session name, or nothing) and:
  - `necromancy_find_spaces` — scan `~/.claude/projects/*` and live workspaces, present revivable candidates.
  - `necromancy_list_sessions` — enumerate the dead sessions that lived in a space (disk is authoritative), ranked by recency, marked live vs dead, with a per-session preview.
  - `necromancy_anchors` — deterministically regex-extract a session's "always grab" set (ask, final state, commits, PRs, versions, files touched, errors, test results, decisions) so a catch-up is grounded on evidence and misses nothing load-bearing. No model call.
  - `necromancy_outline` / `necromancy_search` / `necromancy_read` — read a past session's turns in place: outline its shape, search it by keyword or regex, and pull specific turns back verbatim, all capped on count and bytes.
- **`necromancy` skill** — drives the find-a-space → list → outline → search → read flow conversationally.
- **`/herderp:ghost` command** — a one-shot catch-up: reads the previous session, or point it at an agent/space name and/or a session id to read a specific one. Get a plain summary of what it did and where it stopped, plus resume questions. Reading only — it never revives.

## How reading works

Claude sessions persist on disk at `~/.claude/projects/<cwd-slug>/<uuid>.jsonl` independent of herdr pane life (the slug maps each `/` **and** `.` in the cwd to `-`). Necromancy enumerates them from disk and reads their turns in place — no pane, no relaunch. The reader parses the raw jsonl, skips empty/oversized/malformed files by `stat` alone, and validates every session id against a strict UUID regex before touching the filesystem.

## Requirements

- [`bun`](https://bun.sh) on `PATH` (the server runs under bun; dependencies auto-install on first launch — no `bun install` needed).
- A running `herdr` server and the Claude Code session store at `~/.claude/projects`. Both degrade gracefully with a clear message if absent.

## Install

Via the [rtd marketplace](https://github.com/ryanthedev/rtd-claude-inn):

```
/plugin marketplace add ryanthedev/rtd-claude-inn
/plugin install herderp@rtd
```

## Development

```bash
bun install
bun test            # unit + integration (side-effect-free)
bun run start       # boot the MCP server on stdio
```

## Scope (v1)

Claude agents only; reading only (find, list, and read past sessions in place). Non-Claude agent kinds are a later seam.
