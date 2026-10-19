# herderp

A Claude Code plugin: a stdio **MCP server** wrapping the [`herdr`](https://github.com/ryanthedev/herderp) CLI with curated one-shot tools, plus **session necromancy** — find and read a previous Claude Code agent session from a herdr "space."

## What it does

- **Curated herdr tools** — MCP calls over the `herdr` CLI instead of hand-typing it. One tool per *resource*, each taking an `action`, so ~35 CLI subcommands cost six tools rather than thirty-five:
  - `herdr_agent` — `list`/`get`/`read`/`send`/`focus`/`rename`/`start`/`wait`/`explain`.
  - `herdr_pane` — `list`/`get`/`run`/`close`/`rename`/`focus`/`split`/`swap`/`move`.
  - `herdr_tab` and `herdr_workspace` — `list`/`get`/`create`/`rename`/`focus`/`close`.
  - `herdr_worktree` — `list`/`create`/`open`/`remove`.
  - `herdr_session_list` — herdr's own named server sessions (not Claude Code sessions).
  - `herdr_host` — `list`/`add`/`remove`/`check` the **named remote hosts** every tool above accepts via an optional `host` field (see below).

  Every result carries a `hint` naming the natural next call, and a missing field is rejected by name (`herdr_agent{action:"get"} requires "target"`) rather than falling through to herdr's usage text. herdr's own integration plumbing (`pane report-agent`/`report-metadata`/`release-agent`) and the interactive `agent attach --takeover` are deliberately not exposed.
- **Necromancy** — catch up on past Claude Code work by reading session transcripts in place (reading only; nothing is ever revived):
  - `necromancy_digest` — "what's been happening here": the newest sessions of a space in one call (default 5, max 10), each with its ask, where it ended, and its newest anchors. Skips the running session, marks earlier catch-ups (`catchUp`), and leaves out headless SDK runs unless asked (`headlessSkipped` counts them).
  - `necromancy_search_all` — search the *content* of sessions when you know **what** happened but not **where**: one entry per matching session (its space, id, match count, a representative snippet, last activity), newest first. Scans the whole local history by default (up to 2000 transcripts); `truncated`/`scanTruncated` say when a bound cut it short.
  - `necromancy_find_spaces` — the projects with recorded sessions, joined with live herdr workspaces, newest-active first and capped; narrow with `query`. Degrades to an unlabeled list (`degraded: true`) if herdr is unreachable.
  - `necromancy_resolve` — turn a herdr agent handle (`upublish:1` = workspace label `upublish`, tab labeled `1`; `:1` or a bare `1` = tab 1 in the current space) into the exact live session it addresses. Ambiguity and misses come back as candidates / a typed reason to fall through, not a wrong guess.
  - `necromancy_list_sessions` — every session in a space, newest first, marked live vs dead, with a preview, the herdr handle for live ones, and `entrypoint` for headless launches. Degrades to a still-usable list (marked) if herdr is unreachable.
  - `necromancy_anchors` — regex-extract a session's "always grab" set (ask, final state, commits, PRs, versions, files touched, errors, test results, decisions). Each item is `{text, index}` — the turn it came from — and each list keeps its newest entries, with `omitted` counting what was dropped. No model call.
  - `necromancy_outline` / `necromancy_search` / `necromancy_read` — read a session's turns: outline its shape (`view: "spine"` for just the asks and replies), search it by keyword or regex, and pull specific turns back verbatim (`toolResultChars` clips tool output), all capped on count and bytes.
- **`necromancy` skill** — picks the entry point (digest, cross-session search, handle, or a named space), reads only what matters, and stays honest about every cap.
- **`/herderp:ghost` command** — a one-shot catch-up: the previous session by default, or point it at a space, a handle, or a session id. Get a plain summary of what it did and where it stopped, with turn citations and questions to resume. Reading only — it never revives.

## Remote hosts

Every `herdr_*` tool takes an optional `host`. Omit it for this machine's herdr server; name a registered host to drive the herdr server on another machine instead — `herdr_agent{action:"prompt", target:"w6:p2E", text:"...", host:"ska"}` asks an agent on `ska`. The necromancy tools read this machine's session files and take no host.

Hosts live in `~/.config/herderp/hosts.json` (override with `HERDERP_HOSTS_PATH`), which `herdr_host{action:"add"}` writes for you and which is re-read on every call, so edits need no restart:

```json
{
  "hosts": {
    "ska": {
      "ssh": "100.64.0.10",
      "user": "jane.doe@corp.example",
      "herdr": "/opt/homebrew/bin/herdr"
    },
    "box": "me@box.example"
  }
}
```

- `ssh` is the destination as `ssh` takes it: a hostname, IP, `user@host`, or a `~/.ssh/config` alias. The string shorthand is just `{ "ssh": ... }`.
- `user` (optional) is passed as `ssh -l`; use it for account names containing `@`, which `user@host` would mis-split.
- `herdr` (optional) is the remote binary when it is not on ssh's non-interactive `PATH`. `~/.local/bin` and `/opt/homebrew/bin` are searched by default.
- `socket` (optional) selects a non-default remote server session via `HERDR_SOCKET_PATH`.

Each call is one `ssh` exec of the **remote machine's own** `herdr` binary, so the two herdr versions need not match and nothing long-lived has to be babysat. ssh runs in `BatchMode` (it will never prompt — keys or Tailscale SSH must already work; run `herdr_host{action:"check"}` once after adding a host to prove it) and accepts a new host key on first contact. herdr's exit status travels in-band, because Tailscale SSH reports exit 0 regardless of what the remote command returned. ssh's own failures come back as `[host_unreachable]`, an unregistered name as `[unknown_host]` naming the known hosts.

## How reading works

Claude sessions persist on disk at `~/.claude/projects/<cwd-slug>/<uuid>.jsonl` independent of herdr pane life (the slug maps **every** non-alphanumeric character in the cwd to `-` — `/`, `.`, `_`, `@` and the rest — without collapsing runs, so `prod-_x` becomes `prod--x`). Necromancy enumerates them from disk and reads their turns in place — no pane, no relaunch. The reader parses the raw jsonl, skips empty/oversized/malformed files by `stat` alone, and validates every session id against a strict UUID regex before touching the filesystem.

## Requirements

- [`bun`](https://bun.sh) on `PATH` (the server runs under bun; dependencies auto-install on first launch — no `bun install` needed).
- A running `herdr` server and the Claude Code session store at `~/.claude/projects`. Both degrade gracefully with a clear message if absent.
- For remote hosts: `ssh` on `PATH` and non-interactive access to each host (keys or Tailscale SSH).

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
