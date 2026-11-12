# herderp

A Claude Code plugin: a stdio **MCP server** over both herdr engines — the [`herdr`](https://github.com/ryanthedev/herderp) TUI server and **herdr-core** (`hc`), which runs the **Herdr desktop app**'s terminals — with curated one-shot tools, plus **session necromancy**: find and read a previous Claude Code agent session from a herdr workspace or Herdr app space.

## What it does

- **Curated herdr tools** — MCP calls over the `herdr` CLI instead of hand-typing it. One tool per *resource*, each taking an `action`, so ~35 CLI subcommands cost six tools rather than thirty-five:
  - `herdr_agent` — `list`/`get`/`read`/`prompt`/`send_keys`/`focus`/`rename`/`start`/`wait`/`explain`/`interrupt`/`watch` (see [Watching agents](#watching-agents)), and `adopt` (see [Moving a session into the Herdr app](#moving-a-session-into-the-herdr-app)).
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

## Two engines: herdr and the Herdr app

The Herdr desktop app doesn't run its terminals on the `herdr` server. They live in **herdr-core** (`hc`), and the window's spaces, tabs and panes are driven by `herdr-app`. Both engines can run at once, so herderp drives both through the same tools:

| | herdr (TUI) | Herdr app (herdr-core) |
|---|---|---|
| Talks to | `herdr` CLI | `hc connect` (JSON-RPC), `herdr-app ls` / `herdr-app do` |
| Containers | workspace > tab > pane | space > tab > pane |
| Ids | `w8`, `w8:tD`, `w8:pG`, `term_…` | terminal `t3s` / `ska/t3s`, space `sp…`, tab `tb…`, pane `p…` |
| Agent status | herdr's detector | the agent's own report: `idle`, `working`, `blocked`, `done`, `error` |
| Remote machines | `host` from herderp's `hosts.json` | `host` = an `hc machine ls` name (`ska/t7`) |

- **Which engine answers:**
  - **Lists** cover both. Every row carries `engine`. If one engine is down, you get the other's rows plus a `degraded` entry naming it.
  - **An id's shape** picks its engine.
  - **A bare name** like `review` is looked up in both. If both engines have it, the call fails with `[ambiguous_target]` rather than guessing.
  - **Calls that create something** (a space, a tab, an agent) go to the engine the caller runs in: `HC_TERMINAL_ID` means core, `HERDR_WORKSPACE_ID` means herdr.
  - **`engine:"herdr"|"core"`** forces one.
- **What differs on core:**
  - **`read`** takes `lines`: 0, the default, reads the visible screen, which is fast.
  - **`prompt` and `wait`** wait until the agent stops working, so `until` is rejected.
  - **`start`** opens a new terminal in the window (`kind`, plus optional `argv`, `cwd`, `place`, `name`). Agents (and `adopt`) launch through `env -u` for Claude's per-session markers (`CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_PID`, `CLAUDECODE`, …). A core installed or started from a Claude shell otherwise hands them to every new terminal, and the Claude started there saves no transcript.
  - **`herdr_pane` `focus`** works by pane id, and `run` types into the pane's terminal.
- **herdr only:** `rename` and `explain` (agent), `move` and pair `swap` (pane), and worktrees. On core these fail with `[unsupported_on_core]` and say what to use instead.
- **Necromancy** marks sessions live in either engine and resolves handles such as `upublish:1` against herdr workspaces and Herdr app spaces alike.
  - **Same name in both engines** (the normal state while moving over): if only one engine's tab holds a live Claude, the handle resolves there. Otherwise the result is `ambiguous_workspace`, with each candidate tagged `engine`.
  - **The current space** defaults to `HERDR_WORKSPACE_ID`, else the Herdr app space of `HC_TERMINAL_ID`.
- **Who is who.** Several agents in one space lose track of each other easily, so the tools say who everyone is:
  - **You:** `herdr_agent` `list` marks the caller's own row `you: true`, and a top-level `you` gives its engine, target and place. If the caller runs outside both engines, `you` says so, and no row is marked. `get` marks the caller too. The caller is found from `HERDR_PANE_ID`, else `HC_TERMINAL_ID`.
  - **Senders:** a core `prompt` from a Herdr app terminal passes that terminal to hc as the caller. The agent then reads `<hc from="t3s">…</hc>` and knows who sent it. The result's `from` names the sender. When it is `null`, the message arrived unsigned: either the caller isn't a Herdr app terminal (say who you are in the text), or the text is a `/command` or `!shell` line, which is never signed because the tag would turn it into a plain message. hc tags every send that crosses machines, so a `/command` for a `machine/t7` terminal is sent from that machine (`hc exec --on`), where it arrives untagged. A `!shell` line for another machine keeps the tag, so it arrives as a message rather than running a shell there.
  - **Invisible agents:** anything created in herdr by a caller that isn't in herdr, or on a remote host, comes back with a `notice`. The Herdr desktop app shows only herdr-core, so the user won't see it there.
- **How a core terminal's Claude session is found:** the terminal's foreground pid leads to `~/.claude/sessions/<pid>.json`. This needs Claude Code in the foreground on this machine, so terminals on remote core machines report `sessionId: null`.

### Gotcha: never launch Herdr from a Claude shell as is

Don't start **any** Herdr window, the main one or a test one, from a Claude Code shell (its Bash tool, or a terminal a Claude started) without stripping Claude's per-session environment:

```sh
env -u CLAUDECODE -u CLAUDE_PID -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SESSION_ID \
    -u CLAUDE_CODE_SESSION_ATTENDED -u CLAUDE_CODE_ENTRYPOINT \
    -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDE_CODE_MESSAGING_TOKEN -u HC_TERMINAL_ID -u HC_SCOPE \
  open -g -n -a Herdr   # add --env HERDR_APP_HOME=... for a test window
```

- **Why:** the window inherits the shell's environment and hands it to every terminal it starts. A Claude started there inherits `CLAUDE_CODE_CHILD_SESSION=1` and prints "Transcript saving is off". It can't be resumed, adopted, or read by necromancy.
- **Seen 2026-11-08:** on agents started from a test window, and on the main window after a relaunch from a Claude shell.
- **It isn't herderp:** `herdr-app do` doesn't forward its caller's environment, so `herdr_agent{action:"start"}` and `adopt` don't cause this.
- **Fixing it:** restart the window cleanly. Terminals it already started keep their environment, so restart those agents too.
- **Test windows share your layout:** every window shares one herdr-core and its layout, so `tab.new` or `pane.split` sent to a test window lands in your real spaces.

## Moving a session into the Herdr app

`herdr_agent{action:"adopt", target:"w8:pG"}` moves a Claude Code session out of a herdr pane:

1. **Check it's at rest.** It refuses unless the herdr agent is `idle` or `done`. Two live Claude processes must never share one session, and `unknown` might be mid-turn.
2. **Resume it in the Herdr app.** It runs `claude --resume <session>` in the same folder, as a tab in `workspaceId` (a Herdr app space id) or in a new space named `label` (default: the herdr workspace's label). It starts through your login shell, so your usual `claude` alias or flags apply.
3. **Wait for it.** The new terminal has to report a status and show a Claude session.
4. **Close the old pane.** This happens only now, and only if the old agent is still at rest.

If the new terminal doesn't come up, or the old agent starts working meanwhile, adopt closes the **new** terminal and leaves the herdr pane exactly as it was. Adopt works on this machine only, because Claude's session files live here.

## Watching agents

`herdr_agent{action:"watch"}` lets one agent keep working while it watches others, and get woken when they need it. MCP tools can't push messages into a conversation, so the action returns a **command for Claude Code's Monitor tool**, which turns each line the command prints into a notification:

```
herdr_agent{action:"watch", targets:["cap-api","cap-ui"], stallMs:600000}
→ { command: "'bun' 'run' '…/src/watch/cli.ts' 'cap-api' 'cap-ui' '--stall' '600000'",
    description: "herdr agents: cap-api, cap-ui", timeout_ms: 1800000, targets: [...], hint: "…" }

Monitor({ command, description, timeout_ms })
```

The targets are resolved when you call the action, so a typo fails there, not after arming. Once armed, the watcher prints one line per event worth acting on:

| Line | When |
|---|---|
| `[cap-api] watching - currently working (session 1a2b3c4d)` | Once per target at start. A target that has already stopped shows its status here. |
| `[cap-api] done after 12m working - last: "…" (session 1a2b3c4d)` | The agent finished its turn. `idle` reads the same way. The last line of its own reply is quoted from its transcript. |
| `[cap-ui] blocked after 40s working - needs input (a permission prompt or a question)` | The agent is waiting on someone. |
| `[t7] error after 3m working` | A Herdr app agent reported an error. |
| `[cap-ui] stalled - no activity for 10m while working` | With `stallMs`: nothing has been written to its transcript and its status hasn't changed for that long. Set `stallMs` longer than your slowest expected command. |
| `[cap-db] gone - agent exited` | The pane closed or the agent quit. |
| `[watch] lost herdr's event stream - …` | herdr went away. The watch exits with status 1; re-arm it once herdr is back. |

- **Options:** `once:true` exits after the first event (use it for "tell me when this one finishes"). `verbose:true` also reports agents starting to work again. `json:true` prints every line, including the start and failure lines, as one JSON object with a `type` field.
- **Expiry:** Monitor ends a watch after 30 minutes at most. Re-arm it with the same command to keep watching.
- **Both engines:** one watch can mix herdr agents and Herdr app terminals. herdr agents come through herdr's socket. Herdr app terminals come through herdr-core's event stream (`events.subscribe` over `hc connect`) and are watched by address, so the line shows `t7`. Losing either stream ends the watch, and the last line names which one was lost.
- **Sub-agents:** hc already notifies a parent agent when its own children (the terminals it started) finish, block or exit. Watch is for every other agent.
- **Scope:** the watch runs on this machine. It doesn't take `host` yet.

## Remote hosts

Every `herdr_*` tool takes an optional `host`. For a **Herdr app** call it is the name of a machine herdr-core already knows (`hc machine ls`): a core target becomes `<host>/<address>`, a list keeps that machine's rows, and a new space is made there. The rest of this section is about **herdr**: omit `host` for this machine's herdr server, or name a registered host to drive the herdr server on another machine instead — `herdr_agent{action:"prompt", target:"w6:p2E", text:"...", host:"ska"}` asks an agent on `ska`. The necromancy tools read this machine's session files and take no host.

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
- A running `herdr` server and/or the Herdr app's herdr-core (`hc` and `herdr-app` on `PATH`), plus the Claude Code session store at `~/.claude/projects`. Each degrades gracefully with a clear message if absent.
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
