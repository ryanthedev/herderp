# Review: Phase 3 - Necromancy core + tools (sample 3)

## Executed Results (Step 0)
- Test suite: `bun test` → **87 pass, 0 fail** (256 expect calls, 8 files). The stderr stack traces in the output are intentional `console.error` logging from registry.ts error tests, not failures.
- Typecheck: `bunx tsc --noEmit` → exit 0, clean.
- Coverage: `bun test --coverage` → core.ts / preview.ts / tools/necromancy.ts / registry.ts / curated.ts **100% funcs / 100% lines**; herdr/client.ts 97.44% funcs / 94.91% lines (uncovered: 54-60, 286-289 — see Coverage gaps).
- Lint: no lint script exists in package.json; dispatch names only test/coverage/tsc. N/A.

## Requirement Fulfillment

### DW-3.1
PREMISE:  `deriveSlug(cwd)` maps each `/` and `.` → `-` (`/Users/r/repos/herderp/.necrotest` → `-Users-r-repos-herderp--necrotest`).
EVIDENCE: src/necromancy/core.ts:34-36 (`cwd.replace(/[/.]/g, "-")`)
TRACE:    `/Users/r/repos/herderp/.necrotest` → leading `/`→`-`, each separator `/`→`-`, `.`→`-` before `necrotest` → `-Users-r-repos-herderp--necrotest` (double dash where `/.` was adjacent). Executed: `DW_3_1_derives_the_verified_necrotest_slug` (core.test.ts:81) plus dotted/hidden/multidot/dash/empty variants (core.test.ts:85-95) — all pass.
VERDICT:  **PASS**

### DW-3.2
PREMISE:  `findSpaces()` enumerates the projects root, joins with live workspaces by cwd, returns cwd/label/sessionCount/lastActivity per space.
EVIDENCE: src/necromancy/core.ts:184-219 (readdir projectsRoot → dirs; `liveBySlug` keyed by `deriveSlug(workspace.cwd)` at 198-203; SpaceInfo assembly at 210-216 with cwd, label, workspaceId, sessionCount, lastActivity)
TRACE:    Two fixture dirs (one joined to live workspace w1, one dead) → live space gets label "alpha"/workspaceId "w1"; dead space's cwd recovered from a session line's `cwd` field; lastActivity = newest mtime, sessionCount = file count. Executed: `DW_3_2_findSpaces_joins_disk_and_live_workspaces` (core.test.ts:126) → exact object equality on both spaces; empty-space degrades to raw slug (core.test.ts:160); paneless `cwd:""` workspace and duplicate-cwd first-wins tolerated (core.test.ts:180). All pass.
VERDICT:  **PASS**

### DW-3.3
PREMISE:  `listSessions(cwd)` enumerates `<slug>/*.jsonl`, ranks by mtime desc, marks live vs dead (via agentList), adds preview + messageCount, excludes nested `subagents/`, skips malformed/empty/oversized files without crashing.
EVIDENCE: src/necromancy/core.ts:221-247 (scanSessionFiles at 122-144: non-recursive readdir + UUID-named `.jsonl` filter + mtime-desc sort; size gate at 147-149; liveIds from agentList at 228; preview/messageCount via parseSessionPreview at 235-243). preview.ts:20-41 (summary-preferred preview, user/assistant messageCount).
TRACE:    3 files with mtimes 07-01/07-08/07-05, agent live for U3 → order [U2,U3,U1], live [false,true,false], newest carries preview "newest"/count 1. Empty file (size 0) and >200-byte file excluded by stat alone; `not json\n{broken` content skipped via parseSessionPreview→null; `subagents/` nested dir never entered (no recursion); `notes.jsonl`/`U3.txt` filtered by name. Executed: core.test.ts:203, 225, 245, 275 (unknown space → `[]` with zero herdr calls), 283 (agentList HerdrError propagates typed) + 9 preview.test.ts cases — all pass.
VERDICT:  **PASS**

### DW-3.4
PREMISE:  `revive(sessionId,cwd)` validates the UUID, creates a workspace, runs `claude --resume <id>` via `paneRun` on the created workspace's rootPaneId, waits (bounded) for detection, returns `{workspaceId,paneId,sessionId,detected}`; workspace/pane create failures surface as a typed error, not a partial-state crash.
EVIDENCE: src/necromancy/core.ts:249-291 (UUID gate 253-258; on-disk gate 262-270; workspaceCreate 274; `paneRun(workspace.rootPaneId, \`claude --resume ${sessionId}\`)` 275; bounded poll 280-290). Addendum: src/herdr/client.ts:273-295 (workspaceCreate extracts `result.root_pane.pane_id` → `rootPaneId`, validated at 285-290).
TRACE:    Valid UUID + on-disk file → workspaceCreate({cwd}) → paneRun("w9:p1", "claude --resume <U1>") → poll: miss then hit in pane w9:p2 → returns detected agent's placement `{workspaceId:"w9",paneId:"w9:p2",sessionId,detected:true}` with exactly one 100ms sleep. Timeout path: detectTimeoutMs=300/poll=100 → polls at elapsed 0/100/200/300 (4 polls, 3 sleeps) → `{...created ids, detected:false}` — bounded, no throw. Create failure: HerdrError("command_failed") propagates typed, paneRun never called. Executed: core.test.ts:311, 343, 370 (real default setTimeout sleep), 391, 412; client.test.ts:136/159/179 for the rootPaneId addendum. All pass.
VERDICT:  **PASS**

### DW-3.5
PREMISE:  non-UUID or nonexistent-file id → typed rejection (NO command constructed for a malicious id); herdr live-id with no file does not break `listSessions`.
EVIDENCE: src/necromancy/core.ts:253-258 (gate 1: `UUID_RE.test` before line 275's command template exists on any path; hostile id kept inert in the error via `JSON.stringify(sessionId.slice(0,80))`), 262-270 (gate 2: stat before any client call), 228+241 (listSessions: disk-driven join — a live sessionId with no file simply never matches).
TRACE:    `x; rm -rf ~` → fails UUID_RE at line 253 → NecromancyError("invalid_session_id") thrown; lines 262-290 (stat, workspaceCreate, paneRun, agentList) unreachable — no command string ever built. Executed: `DW_3_5_non_uuid_id_rejected_before_any_command_is_constructed` (core.test.ts:429) runs 8 hostile ids — `x; rm -rf ~`, `$(whoami)`, `` `touch /tmp/pwned` ``, `<uuid>; echo pwned`, `<uuid>\n` (confirms JS `$` does not tolerate a trailing newline), bad-hex `...111Z`, `--help`, `""` — asserting typed error AND `calls == []` on a tracking client covering all 10 HerdrClient methods. UUID-with-no-file → NecromancyError("session_not_found"), zero calls (core.test.ts:454). Live-id-no-file → listSessions returns disk sessions unbroken (core.test.ts:261). All pass.
VERDICT:  **PASS**

### DW-3.6
PREMISE:  the three necromancy tools registered with I/O schemas, present in `tools/list` on the real server.
EVIDENCE: src/tools/necromancy.ts:14-38 (necromancy_find_spaces / necromancy_list_sessions / necromancy_revive via registerTool with zod inputSchemas; outputs are the typed SpaceInfo/SessionInfo/ReviveResult shapes JSON-serialized, documented in each description); src/server.ts:39 (wired into the real entry point).
TRACE:    Real server spawned via `bun run src/server.ts`, real MCP JSON-RPC handshake → tools/list contains all three names. Executed: `DW_3_6_necromancy_tools_appear_in_the_real_servers_tools_list` (test/server.test.ts:83) + registration/schema/pass-through/isError tests (tools.test.ts:34-112). All pass. Note: no formal MCP `outputSchema` is registered — the Phase-1 registerTool harness (a given contract) has no outputSchema parameter; outputs are schema'd at the TypeScript level and stated in descriptions. See Notes.
VERDICT:  **PASS**

### DW-3.7
PREMISE:  unit tests cover slug edge cases (dotted/hidden paths), ranking, miss case, malformed jsonl, oversized file, subagent-dir exclusion, create-failure, and non-UUID rejection (stubbed FS + client — no real ~/.claude/projects, no live herdr).
EVIDENCE: test/necromancy/core.test.ts — slug edge cases :85-95; ranking :203; miss cases :343 (detection miss → detected:false) and :454 (session_not_found); malformed jsonl :225 + preview.test.ts:54-64; oversized :225-243 (valid content over an injected 200-byte cap, proving the stat gate fires instead of a read); subagents exclusion :245; create-failure :391; non-UUID rejection :429. Isolation: per-test `mkdtemp` projectsRoot (core.test.ts:102) — never ~/.claude/projects; stubClient/trackingClient (:39-78) whose unstubbed methods throw — never a live herdr.
TRACE:    All of the above executed in Step 0's `bun test` run → contribute to 87 pass / 0 fail; coverage on all three phase-3 source files is 100% funcs / 100% lines.
VERDICT:  **PASS**

**All requirements met:** YES

## Test-DW Coverage
- [x] All DW items have corresponding tests that ran in Step 0 (test names carry DW ids)
- [x] Phase-3 primary files (core.ts, preview.ts, tools/necromancy.ts) at 100% funcs / 100% lines
- **Gap vs the stated "100% of unit-testable code" level:** src/herdr/client.ts:286-289 — the branch where `result.root_pane` EXISTS but is malformed (not a record, or `pane_id` not a string) is uncovered. The existing test (client.test.ts:179) omits `root_pane` entirely, so `unwrapResult` throws first and this sibling branch never executes. It is unit-testable in one stub (`root_pane: {}`) and lies inside the in-scope workspaceCreate addendum. It maps to no DW item and demonstrates no defect (both paths throw the same typed `invalid_response`), so per verdict rules it is a gap, not a blocker — but it should be closed. (client.ts:54-60, the real `Bun.spawn` runner, is the legitimately non-unit-testable remainder.)

## Dead Code
None found. No unused imports (tsc clean), no unreachable code, no debug statements, no commented-out blocks in the reviewed files.

## Correctness Dimensions
| Dimension | Status | Evidence |
|-----------|--------|----------|
| Concurrency | PASS | No shared mutable state; all awaits sequential per call; poll loop bound is computed in requested-sleep units so it cannot drift. No defect demonstrable. |
| Error Handling | PASS | ENOENT → empty/skip/typed rejection everywhere it is anticipated (core.ts:127, 140, 155, 189, 266); everything else rethrows loud; NecromancyError/HerdrError typed; registry converts throws to isError results (executed: tools.test.ts:97). Adversarial trace — agentList throwing mid-listSessions → typed HerdrError, not everything-dead (executed core.test.ts:283). |
| Resources | PASS | Whole-file reads bounded by the 32 MiB stat gate BEFORE read (traced core.ts:147-149 + 232; executed oversized test proves no read occurs). promises-API fs, no handles held; no timers leak (sleep resolves; loop always terminates for pollIntervalMs ≥ 1 — see Notes for the 0 case). |
| Boundaries | PASS | Empty dir → `[]`; `files[0]?.mtimeMs ?? null`; `sessionId.slice(0,80)` safe on ""; empty-string slug round-trips (`deriveSlug("") === ""`, executed); clip() exact at 120 chars (executed preview.test.ts:34). |
| Security | PASS | Injection guard scrutinized: UUID_RE is fully anchored, charset `[0-9a-f-]` is shell-inert, and JS `$` without `/m` rejects trailing `\n` (executed with `<uuid>\n` hostile id). Gate 1 (regex) and gate 2 (on-disk stat) both precede ANY command construction or herdr call — proven by zero-calls tracking assertions over all 10 client methods for 8 hostile ids. cwd cannot traverse: `deriveSlug` maps every `/` and `.` to `-` before the path join, and cwd reaches herdr only as a discrete argv element (client.ts:277, array spawn, no shell). Hostile ids are JSON.stringify'd in error messages (inert). Flag injection impossible: a UUID starts with a hex digit, never `-`. |

## Loaded-Skill Criteria
| Skill | Criterion | Status | Evidence |
|-------|-----------|--------|----------|
| cc-defensive-programming | External input validated at entry (barricade) | PASS | sessionId: strict UUID gate + on-disk existence, both before any external effect (core.ts:253-270; executed zero-calls tests). cwd: slug-neutralized before FS join; argv-only to herdr. jsonl file content: size-gated by stat, then parsed line-by-line defensively. herdr stdout: validated in client (given contract). |
| cc-defensive-programming | No empty catch blocks | PASS | Every catch either rethrows non-ENOENT (core.ts:128, 140, 156, 190, 269) or implements the DW-3.3-specified skip policy with an observable outcome (session omitted) and a comment (core.ts:174-175, preview.ts:50-51). No swallowed-and-ignored failure. |
| cc-defensive-programming | Assertions used for bugs only / no executable code in assertions | N/A | No assertions in the reviewed code; anticipated runtime conditions all use error handling, which is the correct side of the skill's table. |
| cc-defensive-programming | Failure surfacing (no silent failure) | PASS | Timed-out detection is an honest `detected:false` return, not a hidden success (executed core.test.ts:343); permission errors stay loud rather than degrading to empty lists (core.ts:128 comment + rethrow). |
| aposd-designing-deep-modules | Deep module / information hiding | PASS | 3-method interface (findSpaces/listSessions/revive) hides the graveyard layout, slug rule, jsonl parsing, skip policy, UUID barricade, command construction, and detection poll (core.ts:1-18). Tools layer is one-call-thin by design. Common case (revive) needs two args. |
| aposd-designing-deep-modules | No information leakage / false abstraction | PASS | Slug lossiness is contained: callers never un-slug; findSpaces recovers real cwds internally (core.ts:160-182). rootPaneId addendum keeps pane knowledge inside the client seam. Callers need no knowledge the interface hides. |

## Notes (non-blocking)
1. **Coverage gap** client.ts:286-289 (malformed-`root_pane` branch of the in-scope addendum) — one stub test closes it; see Test-DW Coverage.
2. **`pollIntervalMs: 0` (or negative) would loop forever** in revive's poll (core.ts:280-289: `elapsed` never grows, the timeout comparison never fires). Internal option, not external input — production (server.ts:39) uses defaults and no requirement asks for option validation — but a `pollIntervalMs > 0` guard or assertion would be cheap insurance.
3. **No formal MCP `outputSchema`** on the tools: the given registerTool harness doesn't support one; outputs are TS-typed and description-documented. If "I/O schemas" was meant literally as MCP outputSchema, that's a harness-level (Phase 1) change, not a phase-3 defect.
4. **Reviving an already-live session** still creates a workspace and runs `claude --resume` before the first poll can find the existing agent (core.ts:274-281) — the result then reports the pre-existing agent's placement while a duplicate resume runs in the new pane. Not a listed requirement or edge case; worth a pre-check in a later phase.
5. `clip()` (preview.ts:81) can split a surrogate pair at char 119 of an oversized preview — cosmetic worst case is one replacement glyph before the ellipsis.

## Issues (if FAIL)
None.

**Verdict: PASS**
