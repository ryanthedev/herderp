# Plan (rev 2 — BUILT): reliable `<space>:<handle>` resolution for the herderp ghost/necromancy flow

> **Status: implemented on `main` working tree (2026-07-19).** Decisions locked at the recommended
> defaults: **D1** = degrade `list_sessions` quietly when herdr is down (surface `degraded:true`);
> **D2** = workspace match exact → unique-substring → candidates; **D3** = `necromancy_resolve` returns a
> clean miss and ghost.md drives the on-disk fallback. Live-verified against real herdr:
> `resolveHandle("upublish:1")` → `a5e24ccb` (the 606-msg agent), `:2` → `2f7552cd`, `upub:1` (substring)
> → `upublish:1`, `upublish:9` → `not_found:tab (tabs: 1, 2)`; `list_sessions` returns all on-disk
> sessions with the two live ones labeled `upublish:1`/`upublish:2`. Full suite: 182 pass / 0 fail.

> Rev 2 folds in a Fable "what-if" red-team (findings F1–F10). The big shift from rev 1: the herdr
> handle is a **resolver that produces a sessionId**, not a replacement for the on-disk session index —
> because ghost/necromancy exists primarily to read **dead** sessions, which have no live herdr pane.

## Problem
A user runs `/herderp:ghost` and asks about a session by a herdr-style handle like `upublish:1`.
Rev-1 behavior resolved `<space>:<index>` as "the Nth session, newest-mtime-first, from
`necromancy_list_sessions`" over ALL on-disk `.jsonl` for that cwd. That numbering doesn't match what the
user typed and — because the ghost command has just written its own transcript to disk — the newest-mtime
session is often the ghost session itself, so `:1` grabbed the running session and answered wrong.

## Ground-truth facts (verified live; unchanged from rev 1 except where noted)
- herdr `agent list` names EVERY agent `"claude"` — the handle `upublish:1` is NOT in the agent JSON.
- `upublish:1` = workspace **label** `upublish` (workspace_id `wC`) + tab **label** `1` (tab_id `wC:t7`)
  → pane `wC:p8` → `agent_session.value = a5e24ccb-…` (the live 606-message agent).
- `herdr agent get upublish:1` → `agent_not_found`; herdr does not resolve this handle itself.
- **A live agent's session `.jsonl` is on disk too** — so resolving a live handle to a sessionId and then
  reading it from disk works. The resolver is only needed to turn the handle into a sessionId.
- **CORRECTION (F5):** tab `number` is a *global* counter, not a per-workspace ordinal — verified upublish's
  tabs are number 7 & 8, w4's single tab is number 21. "1st tab of a workspace" = the tab with the smallest
  `number` among that workspace's tabs, NOT `number == 1`.
- **`herdr tab list` and `herdr pane list` with NO `--workspace` return ALL tabs/panes in one call (F4).**
- The running Claude session's own id is in the **caller's Bash env** as `CLAUDE_CODE_SESSION_ID`, fresh per
  Bash spawn. herdr location is `HERDR_WORKSPACE_ID`/`HERDR_TAB_ID`/`HERDR_PANE_ID`.
- **CORRECTION (F3):** the MCP server process bakes its env at spawn and does NOT track `/clear`/resume —
  a running derp server holds a stale `CLAUDE_CODE_SESSION_ID`. The server must NOT trust its own env as the
  current session id; the caller passes it in.
- Repo conventions: core methods don't clamp caller limits (clamp at the tool layer via zod `.max()`);
  session ids validated against a strict UUID regex before any path is built (`core.ts` `loadTurns`
  barricade); `listSessions` currently propagates `HerdrError` **loud** when herdr is down (DW-3.5).

## Resolution model (revised — the heart of rev 2)

`<space>:<handle>` is resolved by a **precedence ladder**, and the flow ALWAYS announces which rung won:

1. **herdr address** (live). Parse `<label>:<tab>`. Match workspace by label, tab by label (or positional
   index into the workspace's tabs sorted by `number`), pane → validated Claude sessionId. This reads a
   LIVE agent's session from disk. Returns `{sessionId, cwd, handle, live:true, isCurrent}`.
2. **on-disk index** (dead sessions — the fallback that makes ghost's core case work). If step 1 misses
   (`not_found`, distinct from herdr-down), interpret the numeric part as the Nth session from
   `list_sessions` newest-first, **excluding the current session** (`currentSessionId`).
3. **announce.** Whatever wins, the prose states the interpretation and the real matched target, e.g.
   "resolved `upublish:1` as the live agent in tab labeled '1', session a5e2…" or "no live tab '1' — read
   the 1st past session on disk, 3f9c…". This kills the F1 dual-meaning trap.

## Proposed changes

### 1. Grow the HerdrClient seam (F4) — sanctioned addition to the pinned seam
- Add typed `tabList(workspaceId?)` and `paneList(workspaceId?)` methods + `Tab`/`Pane` types in
  `src/herdr/types.ts` (types.ts:2-3 says no speculative fields — these are load-bearing, documented here).
- Use the **bare** (no `--workspace`) forms so enrichment/resolution is ~3 spawns total, not N+1.
- `Tab`: `{ id, workspaceId, label, number, focused }`. `Pane`: reuse/extend the agent shape already
  mapped in `mapAgent` (it carries `tab_id`, `agent`, `agent_session.value`, `cwd`).

### 2. New MCP tool: `necromancy_resolve`
Input: `{ handle: string, currentSessionId?: string, workspaceId?: string }`.
- Parse `<label>:<tab>`; bare `<label>` = no tab part; `:<n>`/`<n>` = current workspace via the passed
  `workspaceId` (validated to exist in `workspace list`; else fall back to the server's own cwd — F3).
- Workspace match tiers (F8): exact label → unique case-insensitive substring → else return candidate list.
- Tab match (F5): exact tab label → positional index into the workspace's tabs sorted by `number`.
  The response echoes the ACTUAL matched tab label so the caller can flag mismatch with what was typed.
- Pane→session (F6/F9): pick the tab's pane whose `agent === "claude"` and whose `agent_session.value`
  passes `UUID_RE`; validate before returning. Multi-pane tab with >1 candidate → candidate list.
  No valid agent → typed `no_agent_in_tab` / `non_claude_agent` (distinct from `not_found`).
- Returns `{ sessionId, cwd, handle, matchedTabLabel, live, isCurrent, source: "handle" }`, where
  `isCurrent = (currentSessionId != null && sessionId === currentSessionId)` — never from server env.
- Typed error codes distinguish: `workspace_not_found`, `tab_not_found`, `no_agent_in_tab`,
  `non_claude_agent`, `ambiguous` (with candidates), and herdr-unreachable (propagated from the client).
  The caller uses "not found / no agent" to fall through to the on-disk index; herdr-unreachable is F2.
- cwd source (F10): use pane `cwd` (not `foreground_cwd`).

### 3. Make `necromancy_list_sessions` degrade + enrich (F2 + F3 + rev-1 §2)
- **Degrade (F2):** wrap the `agentList()` call so herdr-unreachable → all `live:false` plus a top-level
  `degraded: true` flag, instead of throwing. This is a deliberate reversal of the DW-3.5 "loud" decision,
  scoped to herdr being *down* (not other HerdrErrors) — on-disk sessions must stay reachable with herdr off.
  Update the DW-3.5 rationale comment in `core.ts` to record the change.
- **Enrich:** for each live session, attach its herdr `handle` (`<label>:<matchedTabLabel>`), computed from
  the 3 bare herdr calls. Flag `current: true` when `id === currentSessionId` (new optional input to the
  tool, passed by the caller — NOT server env).
- Result shape gains `degraded` and per-session `handle?`/`current?`.

### 4. Rewrite `commands/ghost.md` + `skills/necromancy/SKILL.md`
- Add a first step: obtain `currentSessionId` by running `echo $CLAUDE_CODE_SESSION_ID` in Bash (fresh),
  and pass it into `necromancy_resolve` and `necromancy_list_sessions`.
- Redefine `<space>:<handle>` as the **precedence ladder** above (handle → on-disk index minus current),
  and REQUIRE announcing which rung resolved and the real matched tab label.
- `isCurrent`/`current: true` → never summarize that session; say "that's this session" and offer the
  previous one (list_sessions minus current) (F7).
- herdr-down: `list_sessions` still works (degraded) — read on-disk sessions and say live status is unknown.
- Document `list_sessions` (with handles) as the answer to "list all past sessions in this space".

### 5. Tests
- `necromancy_resolve`: parse; workspace exact/substring/ambiguous; tab label vs positional; global-`number`
  ordering; `no_agent_in_tab`/`non_claude_agent`; empty/`non-UUID` `agent_session.value`; multi-pane tab;
  `isCurrent` only from passed id; `:1` with/without valid `workspaceId`.
- `list_sessions`: handle enrichment; `current` flag; herdr-down → `degraded:true`, `live:false`, no throw.
- Keep clamping at the tool layer; assert the resolver never lets a non-UUID reach the reader barricade.

## Success criteria
- `/herderp:ghost upublish:1` reads `a5e24ccb` on the first resolve, and the reply states it resolved the
  live tab-'1' agent.
- `/herderp:ghost upublish:1` when that agent is DEAD reads the intended on-disk session and SAYS it fell
  through to the on-disk index (no silent wrong-session).
- With herdr stopped, listing a space still returns on-disk sessions (`degraded:true`), never a raw error.
- The current ghost session is never summarized as the target; it's flagged and excluded.
- No regression to the UUID barricade or the caps/truncation contracts.

## Open decisions to confirm before build
- D1 (F2): is reversing DW-3.5 to "degrade quietly when herdr is *down*" acceptable, or should herdr-down
  stay a typed error with ghost.md routing to a separate on-disk-only listing path? (Plan assumes degrade.)
- D2 (F8): workspace matching — exact-only, or exact→unique-substring→candidates? (Plan assumes the latter.)
- D3: should `necromancy_resolve` itself perform the on-disk-index fallback (one tool call, one meaning),
  or return a clean miss and let ghost.md drive the fallback? (Plan assumes the latter — keeps the tool
  deterministic and the precedence/announcement in the prose where the user sees it.)
