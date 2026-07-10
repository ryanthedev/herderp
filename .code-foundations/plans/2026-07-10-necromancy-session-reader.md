# Plan: necromancy session reader — read a prior session instead of reviving it

**Created:** 2026-07-10
**Status:** complete
**Started:** 2026-07-10 14:30
**Completed:** 2026-07-10 16:14
**Duration:** ~1h44m
**Complexity:** simple

---

## Context

The herderp necromancy capability can only *revive* a past Claude Code session (relaunch it live via `claude --resume`) or show a 120-char preview. There is no way for the **current** agent to read a **prior** session's real content on demand to get up to speed — the only alternative is Claude Code's lossy auto-compaction, which drops exactly what an agent needs (stack traces, which files were touched, approaches already tried, exact tool args). This adds a research-backed **session reader**: role-aware, pointer-linked, hard-capped retrieval over the raw `~/.claude/projects/<slug>/<uuid>.jsonl` — additive to, and independent of, the existing revive path.

Design is settled by a web-research breadth run (this session). Load-bearing conclusions:
- The interface agents actually *call* is on-demand search/retrieval tools, not auto-injected summaries (MemGPT `conversation_search`, Anthropic memory tool). No coding agent today exposes a tool to read/search an *arbitrary past session* mid-conversation — this fills that gap.
- Plain grep is the wrong shape for transcripts: flat grep strips conversational role identity (user vs thinking vs tool_use vs tool_result). The winning shape is linked, role-aware views — skim-with-pointers, full verbatim, role-tagged filter (Stanford "View-oriented Conversation Compiler", arXiv:2603.29678).
- Counter-evidence (Chroma context-rot 2025; lost-in-the-middle; "noise worse than nothing"; agents ignore retrieved info): cap slice sizes hard, prefer targeted search over raw paging, never dump big slices, preserve role + position pointers.

Verified jsonl schema (this session): one JSON record per line; `record.type` ∈ {user, assistant, summary, system, ai-title, last-prompt, attachment, file-history-snapshot, …}; `message.content` blocks ∈ {text, thinking, tool_use, tool_result, image}; tool results carry `toolUseResult`; records carry `uuid/parentUuid/timestamp/cwd/gitBranch/sessionId/isSidechain`. Files are MBs / thousands of lines.

## Constraints

- **Additive only.** `necromancy_revive` and the existing `findSpaces`/`listSessions`/`preview` stay byte-for-byte unchanged.
- **Stack unchanged.** Bun + TS + `@modelcontextprotocol/sdk`; deterministic core `bun test`-covered with injected FS; **no new runtime deps** (no embeddings/vector store).
- **Never dump.** Every tool response is hard-capped on **both** result count and bytes; oversized files are stat-gated and never read (reuse `withinSizeGate`).
- **Role-preserving.** search/outline/read carry role tags (user · assistant · thinking · tool_use · tool_result) and stable entry-index pointers. Flat grep that strips role identity is rejected.
- **Reuse addressing.** Tools identify a session by `sessionId` (UUID) + `cwd`, exactly like `revive`/`listSessions`. The reader does not re-implement discovery.
- **Search is lexical.** Case-insensitive substring/keyword (+ optional simple regex). Deterministic, unit-testable.
- **Subagent/sidechain records excluded** (records with `isSidechain: true`), consistent with `listSessions` excluding nested `subagents/`.

---

## Implementation Phases

### Phase 1: Session-reader core (turn model + search / outline / read)
**Skills:** code-foundations:aposd-designing-deep-modules, code-foundations:cc-defensive-programming
**Model:** sonnet
**Gate:** Full
**Security-sensitive:** yes
**Depends on:** none
**File scope:** `src/necromancy/reader.ts, src/necromancy/core.ts, test/necromancy/reader.test.ts`

**Goal:** Turn a session's jsonl into an ordered list of role-tagged, index-addressed **entries**, and expose deterministic `outline` / `search` / `read` over them, plus the factory loader methods that resolve a `(sessionId, cwd)` to that jsonl behind the existing security + size gates.

**Scope:**
- IN:
  - `src/necromancy/reader.ts` (pure, text-in → structured-out, like `preview.ts`):
    - `parseTurns(text): Turn[]` — flatten jsonl into ordered entries. One entry per addressable content block: a user text, an assistant `thinking`, an assistant `text`, each `tool_use` (with tool name + input), each `tool_result` (with its tool name + result text). `index` is a 0-based ordinal in file order over included entries. Skip `isSidechain: true`, non-message/meta records (summary, ai-title, mode, …), and malformed lines — never crash.
    - `outlineTurns(turns, {offset?, limit?}): { entries: OutlineEntry[]; total: number; nextOffset: number | null }` — one short line per entry (`index`, `role`, `tool?`, clipped preview); `filter?: TurnRole` narrows (e.g. `tool_use` → tool-call ledger). Capped by `limit`, paged by `offset`.
    - `searchTurns(turns, query, {limit?, regex?}): SearchMatch[]` — case-insensitive lexical match over entry text; each match carries `index`, `role`, `tool?`, and a bounded snippet with the match in context. Capped at `limit`; report `truncated` when more existed.
    - `readTurns(turns, {from, to?, maxBytes?}): { entries: FullEntry[]; truncated: boolean }` — verbatim content of entries `[from, to]`, span-capped and byte-capped; mark `truncated` when the cap cut it.
  - `src/necromancy/core.ts` factory additions (reuse `deriveSlug`, `scanSessionFiles`/`withinSizeGate`/`readSessionText`, `UUID_RE`, `NecromancyError`): `sessionOutline`, `sessionSearch`, `sessionRead` methods that **validate `sessionId` as a UUID first** (barricade — before building any path), resolve `join(projectsRoot, deriveSlug(cwd), <id>.jsonl)`, stat-gate size, read, `parseTurns`, delegate to the pure fn. Missing/oversized/absent file → typed `NecromancyError` (`session_not_found`) or empty, never a crash. New cap constants (`maxOutlineEntries`, `maxSearchMatches`, `maxReadBytes`, `maxReadSpan`) added to `NecromancyOptions` with defaults, injectable for tests.
- OUT: MCP tool registration and skill prose (Phase 2); semantic/embedding search; any write/summarize/briefing.

**Edge cases (external boundary — untrusted input at entry):** non-UUID `sessionId` → typed rejection **before any path is constructed** (path-traversal barricade; `cwd`'s `/`+`.`→`-` slug already neutralizes `../`); session file absent → `session_not_found`; empty/oversized file → stat-gated, not read; malformed/partial jsonl lines skipped; a record whose `message.content` is a bare string vs a block array both handled; `tool_use` with structured input serialized to bounded text; `read` `from`/`to` out of range clamped; `to < from` → empty; every response independently honors count **and** byte caps.

**Produces:** `Necromancy` factory (from `createNecromancy`) gains three read-only methods —
- `sessionOutline({ sessionId, cwd, offset?, limit?, filter? }): Promise<{ entries: OutlineEntry[]; total: number; nextOffset: number | null }>`
- `sessionSearch({ sessionId, cwd, query, limit?, regex? }): Promise<{ matches: SearchMatch[]; truncated: boolean }>`
- `sessionRead({ sessionId, cwd, from, to?, maxBytes? }): Promise<{ entries: FullEntry[]; truncated: boolean }>`

plus exported types `Turn`, `TurnRole`, `OutlineEntry`, `SearchMatch`, `FullEntry`. Consumed by Phase 2's tool registrations. `revive`/`findSpaces`/`listSessions` signatures unchanged.

**Done when:**
- [ ] DW-1.1: `parseTurns` maps a real fixture jsonl to ordered role-tagged entries — user text, assistant `thinking`, assistant `text`, each `tool_use` (with tool name), each `tool_result` — with stable 0-based `index` in file order; `isSidechain` and meta/malformed records excluded.
- [ ] DW-1.2: `outlineTurns` returns one line per entry (index, role, tool?, clipped text), honors `filter` (e.g. `tool_use` yields only tool calls), and caps/pages via `limit`+`offset` with a correct `total` and `nextOffset`.
- [ ] DW-1.3: `searchTurns` finds case-insensitive lexical matches, returns each with `index`+`role`+`tool?`+bounded snippet, caps at `limit`, and sets `truncated` when more matched.
- [ ] DW-1.4: `readTurns` returns verbatim entry content for `[from,to]`, enforces both span and byte caps, and sets `truncated` when a cap cut the output.
- [ ] DW-1.5: `sessionSearch`/`sessionOutline`/`sessionRead` reject a non-UUID `sessionId` with a typed `NecromancyError` **and construct no filesystem path** for it (assert via injected FS that no read is attempted); an absent file → `session_not_found`; an oversized file is stat-gated and never read.
- [ ] DW-1.6: caps are enforced from `NecromancyOptions` defaults and overridable; a synthetic huge session never yields a response exceeding the byte cap.
- [ ] DW-1.7: `bun test` green; `revive`/`findSpaces`/`listSessions` and their tests unchanged.

**Difficulty:** MEDIUM

### Phase 2: MCP tools + skill guidance
**Skills:** oberskills:prompt, oberskills:skill-craft
**Model:** sonnet
**Gate:** Standard
**Depends on:** Phase 1
**File scope:** `src/tools/necromancy.ts, src/server.ts, skills/necromancy/SKILL.md, test/necromancy/tools.test.ts`

**Goal:** Expose the three reader methods as MCP tools (thin registrations, matching the existing `tools/necromancy.ts` style) and teach the skill when to *read* a session vs *revive* it, and the search → outline → read flow.

**Scope:**
- IN:
  - Register `necromancy_search`, `necromancy_outline`, `necromancy_read` via the existing `registerTool` harness (Phase 1 of the original plan; consumed here, not produced), with zod input schemas (`sessionId`, `cwd`, plus each tool's params) and descriptions that state the caps and the pointer/index contract so the model uses them correctly.
  - Extend `skills/necromancy/SKILL.md`: a "read a session to get up to speed (without reviving)" section — trigger cues, the outline→search→read loop, honor `nextOffset`/`truncated` honestly, and the read-vs-revive decision; update the frontmatter description's triggers/near-misses to cover reading. Keep `validate_skill` clean.
  - Presence tests (three tools in `tools/list` with input schemas) and an integration test driving `outline`→`search`→`read` against a fixture session via the real registry.
- OUT: new core logic (all in Phase 1); the deferred briefing seam.

**Edge cases:** herdr-independent (reader tools never call herdr) — a missing `~/.claude/projects` or absent session surfaces as the Phase 1 typed error rendered by `registerTool` as an `isError` result, not a crash; skill must present `truncated`/`nextOffset` rather than implying the whole session was read.

**Produces:** three registered MCP tools (`necromancy_search`/`necromancy_outline`/`necromancy_read`) live in the server; updated `SKILL.md` (final user-facing deliverable). Consumes Phase 1's factory methods.

**Done when:**
- [ ] DW-2.1: the three tools are registered and appear in `tools/list` with input schemas; each handler is a thin call into the Phase 1 method (no logic); a call with a bad/absent session surfaces as an `isError` tool result via `registerTool`, not a crash.
- [ ] DW-2.2: an integration test drives `necromancy_outline` → `necromancy_search` → `necromancy_read` against a fixture session and gets role-tagged, index-linked, capped results end to end.
- [ ] DW-2.3: `SKILL.md` gains a read-a-session section (outline→search→read, read-vs-revive, honest `truncated`/`nextOffset`) and its frontmatter triggers cover reading/getting-up-to-speed; `validate_skill` returns zero errors.
- [ ] DW-2.4: `bun test` green; existing revive tool + skill flow unchanged.

**Difficulty:** LOW

---

## Test Coverage
**Level:** 100% of unit-testable core lines (Phase 1), plus tool-presence + one integration path (Phase 2).

## Test Plan
- [ ] T1.1: `parseTurns` on a fixture with user/assistant/thinking/tool_use/tool_result/summary/sidechain records → correct ordered role-tagged entries; sidechain + meta excluded [DW-1.1]
- [ ] T1.2: `outlineTurns` filter=`tool_use` returns only tool calls; `limit`/`offset` paging yields correct `total`/`nextOffset` [DW-1.2]
- [ ] T1.3: `searchTurns` case-insensitive match returns index+role+snippet; `truncated` set past `limit` [DW-1.3]
- [ ] T1.4: `readTurns` verbatim `[from,to]`; span cap and byte cap each independently truncate with `truncated:true` [DW-1.4]
- [ ] T1.5 (dirty): non-UUID `sessionId` → typed `NecromancyError` and **zero FS reads** (injected FS asserts no path built) [DW-1.5]
- [ ] T1.6 (dirty): absent file → `session_not_found`; oversized file stat-gated, never read [DW-1.5]
- [ ] T1.7 (dirty): malformed/partial jsonl lines and bare-string `content` handled without crashing [DW-1.1]
- [ ] T1.8 (dirty): synthetic huge session → response never exceeds byte cap [DW-1.6]
- [ ] T2.1: three reader tools present in `tools/list` with input schemas [DW-2.1]
- [ ] T2.2: integration `outline`→`search`→`read` over a fixture via the registry [DW-2.2]
- [ ] T2.3: `validate_skill` zero errors on updated `SKILL.md` [DW-2.3]
- [ ] T2.4 (manual): frontmatter triggers activate on "get up to speed on a past session / what did that session do" and stay quiet on revive-only intents [DW-2.3]
- [ ] T2.5 (dirty): `necromancy_read` on a non-UUID/absent `sessionId` via the registry → `isError` tool result rendering the typed `NecromancyError`, no crash [DW-2.1]

---

## Notes
- **Entry granularity:** the addressable unit ("entry"/`index`) is a content *block*, not a whole message — so the agent can jump to one specific `tool_use` or `thinking` block. `necromancy_read` addresses entries by that same index, so a search hit's `index` is directly readable.
- **Why Full gate on Phase 1:** `sessionId` is untrusted input flowing into a filesystem path — the UUID barricade (copied from `revive`) must fire before any path construction; DW-1.5 proves no path is built for a hostile id. Read-only (no command construction, no herdr calls), so lower blast radius than `revive`, but the traversal surface earns the security review.
- **No briefing in v1** (deliberate). If added later, it must carry pointers back to the entries it summarizes — otherwise it just recreates the compaction we're replacing.

---

## Execution Log

### Phase 1: Session-reader core (Gate: Full, Security-sensitive)
- [x] BUILD: Discovery + design + implementation complete
- [x] REVIEW: 3-sample fable → FAIL/FAIL/FAIL (byte-cap UTF-8 overshoot + coverage) → fixed → PASS/PASS/PASS
- [x] Committed
Commit: ea47486
Summary: `src/necromancy/reader.ts` (pure turn model + `outlineTurns`/`searchTurns`/`readTurns`, role-tagged index-addressed entries) and `src/necromancy/core.ts` `sessionOutline`/`sessionSearch`/`sessionRead` behind a UUID-first `loadTurns` barricade + stat/size gate; every response honors count and byte caps (hard even at multibyte boundaries). 44 reader tests, 100% executable-line coverage; revive/findSpaces/listSessions untouched. NON-BLOCKING for Phase 2: caller-supplied `maxBytes`/`limit`/`offset` are NOT clamped down to the configured caps — the tool layer must ceiling model-supplied values so a tool call can't request an oversized slice.

### Phase 2: MCP tools + skill guidance (Gate: Standard)
- [x] BUILD: Discovery + design + implementation complete
- [x] REVIEW: sonnet single-sample → PASS (1 attempt)
- [x] Committed
Commit: b607855
Summary: three thin reader MCP tools (`necromancy_outline`/`search`/`read`) registered over the existing harness with zod `.max()` ceilings on caller `limit`/`maxBytes` (closes the Phase 1 carry-over); bad/absent sessions render as `isError`, reader tools never touch herdr; `SKILL.md` gains a read-a-session section + reading triggers, `validate_skill` clean. 9 tool tests incl. an end-to-end outline→search→read integration; 145 pass/1 skip/0 fail. FOLLOW-UP (non-blocking): `necromancy_outline` `offset` has no `.max()` ceiling (can't produce an oversized response, so not gating).
