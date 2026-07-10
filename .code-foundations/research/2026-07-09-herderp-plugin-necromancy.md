# herderp — herdr Claude plugin + session necromancy

**What this is:** A Claude Code plugin (stdio MCP wrapping the `herdr` CLI for one-shot asks) whose flagship capability is a **necromancy skill** that revives previous agent sessions from a "space."

**Date:** 2026-07-09 · **Status:** confirmed (full revive cycle verified live)

**Still open (genuine, for planning):**
- **MCP tool surface** — which `herdr` subcommands to expose and at what granularity. Plan-level.
- **Non-Claude agents** — herdr detects ~20 agent kinds; resume semantics differ. v1 is `claude --resume` only; others unverified.
- **Revived-pane naming scheme** — what `<name>`/label to give a resurrected agent (e.g. `necro:<short-uuid>` or reuse prior label). Unspecified.
- **Batch vs one-by-one revive** — user said "resume the agent sessions"; whether the skill revives all of a space's dead sessions or a picked subset is a UX call (default: preview list → user picks).
- **"space" grouping semantics** — herdr's real `space` grouping is currently empty in state; v1 treats a space as a **cwd/workspace**. Revisit if the user starts using herdr spaces.

Resolved and locked below: revive mechanism (verified), slug rule (corrected + verified), kill-persistence (verified), layout policy (resume-only, decided).

---

## Purpose

Make one-shot herdr operations easy from inside Claude (no hand-typing raw CLI), and — the headline — let the user **resurrect a prior agent session** they've lost track of: point at a project/space, see which past sessions lived there, and bring the chosen one back to life resumed in a herdr pane.

## Actors

- **Primary user:** the developer (Ryan) running many concurrent `claude` agents across repos inside herdr, who loses track of past sessions and wants them back.
- **Consumers of the plugin:** Claude Code sessions that load the plugin — the MCP tools and the necromancy skill.
- **Underlying systems:** the `herdr` server (socket API; running **0.7.1**, protocol 14, **0.7.2 available**) and the Claude Code on-disk session store.

## Context — the herdr model (verified)

Hierarchy: **session → space (UI grouping) → workspace → tab → pane → agent.**

- A workspace is effectively identified by `identity_cwd` (its project directory) and an optional `custom_name`/label.
- A pane may host an **agent** (a running `claude`/codex/etc. CLI). `herdr agent list --json` reports live agents with `{agent, agent_session:{value}, agent_status, cwd, workspace_id, tab_id, pane_id}`.
- **Key fact:** for a live agent, `agent_session.value` is the agent CLI's own session id — for Claude, the Claude Code session UUID. Verified against disk for **11 of 12** live agents (see caveat below).
- **Detection lag (verified):** herdr does NOT tag a freshly launched `claude` as an agent at bare boot — only after the session becomes active (first model turn). Any "start/resume then act on the agent" flow must **wait for detection**, not assume immediate registration.
- **Workspace lifecycle (verified):** closing a workspace's last pane auto-closes the workspace.

## The graveyard (where dead sessions actually live) — verified

herdr's own persistence does **not** retain the agent→session mapping for dead panes:
- `~/.config/herdr/session.json` — **live** layout only; holds `agent_session`/`cwd`/`agent` for currently-open panes.
- `~/.config/herdr/session-history.json` — per-pane **ANSI scrollback** for visual restore; grep found **no** `agent_session`/`cwd`/`session_id` fields.

The authoritative store of past sessions is **Claude Code's own**, independent of herdr pane life:
- Path: `~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl`.
- **Slug rule (corrected + verified):** each `/` **and** each `.` in the absolute cwd becomes `-`. So `/Users/r/repos/herderp/.necrotest` → `-Users-r-repos-herderp--necrotest` (note `/.` → `--`). The earlier "`/`→`-` only" was wrong and would miss any dotted path.
- **Subagent sessions** live under `~/.claude/projects/<slug>/<parent-uuid>/subagents/agent-<id>.jsonl` — a nested layer to be aware of when enumerating.

## Verified live — the full necromancy cycle (2026-07-09 test)

Ran an end-to-end test in an isolated workspace at `/Users/r/repos/herderp/.necrotest`:

| Step | Result |
|---|---|
| Start `claude`, send a prompt (`NECRO-OK`) | herdr detected agent, reported session `b377cdde-…`, cwd `.necrotest` |
| Check disk | `~/.claude/projects/-Users-r-repos-herderp--necrotest/b377cdde-….jsonl` present, held the exchange |
| **Kill** (close pane) | agent gone from `agent list`; **jsonl survived on disk (65KB)** — corpse is revivable; workspace auto-closed |
| **Resurrect**: `herdr pane run <pane> 'claude --resume b377cdde-…'` in the cwd | prior conversation reloaded (`NECRO-OK` visible); herdr re-detected the **same** session id `b377cdde-…` |

**Conclusion:** track → kill → `claude --resume <id>` fully restores the session and realigns herdr's reported id. `herdr pane run <pane> 'claude --resume <id>'` is the confirmed invocation (the `herdr agent start … -- claude --resume <id>` argv form is plausible but untested).

## Needs (priority order)

1. **Necromancy skill (flagship).**
   - **Flexible target ("space").** Accept anything the user points at — a herdr workspace id, a workspace label/`custom_name`, a project cwd, a herdr session name — OR nothing, in which case **help the user find a space**: scan `~/.claude/projects/*` (and live workspaces) and present candidates with cwd, recency, session count, and a one-line preview.
   - **List revivable sessions** for a chosen space by enumerating `~/.claude/projects/<cwd-slug>/*.jsonl` (disk is authoritative), ranked by recency (mtime), marking which are already live vs dead, with a preview per session (first user prompt / summary / message count). `herdr agent explain --file <path> --agent claude` is a candidate for the preview.
   - **Revive = resume the agent session.** For each chosen session, in its cwd:
     `herdr pane run <pane> 'claude --resume <session-uuid>'` (create workspace/pane first). Layout best-effort; full scene reconstruction out of scope for v1.
   - **Wait for detection** after launching before reporting success (detection lag is real).
   - **Preview then pick** (default) — one-by-one or batch is a UX detail (see Still open).

2. **One-shot MCP wrapper over herdr.**
   - Thin stdio MCP exposing the herdr socket API (`--json` outputs) so common ops are single tool calls instead of raw CLI: at minimum `agent list/get/read/start/send/wait`, `workspace list/create/focus`, `pane run/close`, `session list`.
   - Designed **together** with necromancy: necromancy is a skill built on these tools plus direct `~/.claude/projects` reads.

## Boundaries / constraints

- **v1 = Claude agents only.** Ship `claude --resume` first; leave hooks for other agent kinds.
- **Resume-only, not layout-rebuild** (v1). Reviving restores the *conversation*, not exact pane geometry. (Decided — no longer open.)
- Depends on `herdr` running (server status check) and the Claude Code store at `~/.claude/projects`.
- Repo `/Users/r/repos/herderp` is greenfield — **not a git repo**; currently holds only `.code-foundations/` (and a leftover `.necrotest/` test dir to delete).

## Risks / assumptions — post-verification

| Assumption | Status | Note |
|---|---|---|
| For a live agent, `agent_session.value` == Claude session UUID | **Verified, with caveat** | 11/12 live agents matched a file; 1 (`0a328d9a`, engram) had **no** on-disk file — likely `/clear`/compaction rotated the id while herdr held the old one |
| Dead sessions persist in `~/.claude/projects/<slug>/*.jsonl` after kill | **Verified** | survived pane close (65KB) |
| `claude --resume <id>` restores the session and herdr realigns the id | **Verified** | full cycle test |
| cwd→slug rule = each `/` and `.` → `-` | **Verified** | `/.` → `--` |
| Live herdr id → on-disk file is **total** | **Refuted** | ~92% here. **Design impl:** enumerate revivable sessions from disk (authoritative); tolerate herdr ids with no file in any "reconcile live agents" feature |
| herdr detects an agent immediately on launch | **Refuted** | detection only after first turn — wait for it |
| `agent explain --file` gives a usable preview | Unverified | try on a real jsonl during build |
| `herdr agent start … -- claude --resume <id>` argv form works | Unverified | `pane run 'claude --resume <id>'` is the verified path |

## What comes next

Take this into planning:
```
/code-foundations:plan .code-foundations/research/2026-07-09-herderp-plugin-necromancy.md
```
