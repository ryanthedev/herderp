# herderp

A Claude Code plugin: a stdio **MCP server** wrapping the [`herdr`](https://github.com/ryanthedev/herderp) CLI with curated one-shot tools, plus **session necromancy** — revive a previous Claude Code agent session from a herdr "space."

## What it does

- **Curated herdr tools** — one-shot MCP calls over the `herdr` CLI instead of hand-typing it: `agent list/get/read/wait`, `workspace create/focus`, `pane run/close`, `session list`.
- **Necromancy** — point at a space (a herdr workspace id, label, project cwd, session name, or nothing) and:
  - `necromancy_find_spaces` — scan `~/.claude/projects/*` and live workspaces, present revivable candidates.
  - `necromancy_list_sessions` — enumerate the dead sessions that lived in a space (disk is authoritative), ranked by recency, marked live vs dead, with a per-session preview.
  - `necromancy_revive` — resurrect a chosen session via `claude --resume <uuid>` in a fresh herdr pane, then wait for herdr to re-detect it.
- **`necromancy` skill** — drives the find-a-space → list → preview → pick → revive flow conversationally.

## How revive works

Dead Claude sessions persist on disk at `~/.claude/projects/<cwd-slug>/<uuid>.jsonl` independent of herdr pane life (the slug maps each `/` **and** `.` in the cwd to `-`). Necromancy enumerates them from disk, then resurrects the chosen one with `herdr pane run <pane> 'claude --resume <uuid>'` in the target cwd. herdr tags an agent only after its first turn, so revive polls with a bounded wait and reports an honest `detected` flag.

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

The live end-to-end revive proof is opt-in (it starts and kills a throwaway session):

```bash
HERDERP_E2E_LIVE=1 bun test test/e2e/revive.test.ts
```

## Scope (v1)

Claude agents only; resume-only (restores the conversation, not pane geometry). Non-Claude agent kinds and layout rebuild are later seams.
