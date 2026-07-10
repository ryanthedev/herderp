# Review: Phase 3 - Necromancy core + tools (sample 1)

## Executed Results (Step 0)
- Test suite: `bun test` → 87 pass / 0 fail (256 expect calls, 8 files)
- Coverage: `bun test --coverage` → src/necromancy/core.ts 100/100, src/necromancy/preview.ts 100/100, src/tools/necromancy.ts 100/100, src/registry.ts 100/100; src/herdr/client.ts 97.44% funcs / 94.91% lines (uncovered: 54-60, 286-289)
- Typecheck: `bunx tsc --noEmit` → exit 0, no errors
- Lint: no lint script/config found in the dispatch or project (`bun test` + tsc are the configured gates)

## Requirement Fulfillment

### DW-3.1
PREMISE:  `deriveSlug(cwd)` maps each `/` and `.` → `-` (`/Users/r/repos/herderp/.necrotest` → `-Users-r-repos-herderp--necrotest`).
EVIDENCE: src/necromancy/core.ts:34-36 (`cwd.replace(/[/.]/g, "-")`)
TRACE:    `/Users/r/repos/herderp/.necrotest` → each `/` and `.` replaced → `-Users-r-repos-herderp--necrotest` (double dash where `/.` was adjacent). Passing tests: `DW_3_1_derives_the_verified_necrotest_slug`, `DW_3_1_slug_handles_hidden_dotted_and_multidot_paths`, `DW_3_1_slug_preserves_literal_dashes_and_maps_trailing_slashes` (core.test.ts:80-96).
VERDICT:  PASS

### DW-3.2
PREMISE:  `findSpaces()` enumerates the projects root, joins with live workspaces by cwd, returns cwd/label/sessionCount/lastActivity per space.
EVIDENCE: src/necromancy/core.ts:184-219
TRACE:    readdir(projectsRoot) → directories only → `client.workspaceList()` indexed by `deriveSlug(workspace.cwd)` → per dir: scanSessionFiles (mtime-desc) → SpaceInfo{cwd (live cwd, else recovered from a session line's `cwd` field, else raw slug), label, workspaceId, sessionCount, lastActivity=files[0].mtimeMs}. Passing tests: `DW_3_2_findSpaces_joins_disk_and_live_workspaces` (both live-joined and dead-space branches asserted field-by-field), `DW_3_2_findSpaces_space_with_no_sessions_degrades_to_the_raw_slug`, `DW_3_2_missing_projects_root_returns_empty_no_crash`, `DW_3_2_tolerates_empty_cwd_workspaces_and_duplicate_cwds_first_listed_wins` (core.test.ts:125-200).
VERDICT:  PASS

### DW-3.3
PREMISE:  `listSessions(cwd)` enumerates `<slug>/*.jsonl`, ranks by mtime desc, marks live vs dead (via agentList), adds preview + messageCount, excludes nested `subagents/`, skips malformed/empty/oversized files without crashing.
EVIDENCE: src/necromancy/core.ts:122-144 (scan: non-recursive readdir + `entry.isFile()` + UUID-named `.jsonl` only + mtime-desc sort), 147-149 (size gate: `size > 0 && size <= maxSessionBytes`, stat-only — oversized never read), 221-247 (agentList join → `live`, parseSessionPreview → preview/messageCount, null → skip); src/necromancy/preview.ts:20-56 (malformed lines skipped, all-malformed → null)
TRACE:    3 files with staggered mtimes → ids returned `[U2, U3, U1]` newest-first, `live` `[false, true, false]` from stub agentList. Empty (0 B), malformed (`not json\n{broken`), and oversized (valid content over injected 200 B cap) files all skipped → only the valid session returned. `subagents/` nested file, `notes.jsonl` (non-UUID), `<uuid>.txt` all excluded. Passing tests: `DW_3_3_ranks_by_mtime_desc_and_marks_live_vs_dead`, `DW_3_3_skips_malformed_empty_and_oversized_jsonl`, `DW_3_3_excludes_nested_subagents_dir_and_non_uuid_filenames`, `DW_3_3_unknown_space_returns_empty_without_touching_herdr`, `DW_3_3_a_herdr_failure_surfaces_as_a_typed_HerdrError_not_all_dead` (core.test.ts:202-300) plus 9 preview tests (preview.test.ts).
VERDICT:  PASS

### DW-3.4
PREMISE:  `revive(sessionId,cwd)` validates the UUID, creates a workspace, runs `claude --resume <id>` via `paneRun` on the created workspace's rootPaneId, waits (bounded) for detection, returns `{workspaceId,paneId,sessionId,detected}`; workspace/pane create failures surface as a typed error, not a partial-state crash.
EVIDENCE: src/necromancy/core.ts:249-291; src/herdr/client.ts:46, 273-295 (rootPaneId addendum)
TRACE:    valid UUID → stat gate passes → `workspaceCreate({cwd})` → `paneRun("w9:p1", "claude --resume <U1>")` (argv pair asserted verbatim in test) → poll agentList; detection on 2nd poll returns the detected agent's own workspaceId/paneId with `detected:true`. Timeout path: pollIntervalMs=100/detectTimeoutMs=300 → exactly 4 polls, 3 sleeps, returns created ids with `detected:false` — bounded, no hang, no throw. workspaceCreate throwing HerdrError("command_failed") propagates typed and paneRun is never reached; paneRun failure likewise propagates typed. Passing tests: `DW_3_4_revive_creates_workspace_runs_claude_resume_and_returns_the_detected_agent`, `DW_3_4_detection_never_arrives_bounded_wait_returns_detected_false`, `DW_3_4_default_sleep_is_a_real_timer_between_polls`, `DW_3_4_workspaceCreate_failure_surfaces_typed_and_paneRun_is_never_reached`, `DW_3_4_paneRun_failure_surfaces_typed_without_a_partial_state_crash` (core.test.ts:302-427); addendum: `DW_3_4_workspaceCreate_surfaces_rootPaneId_from_the_create_envelopes_root_pane`, `DW_3_4_workspaceCreate_throws_invalid_response_when_root_pane_pane_id_is_missing` (client.test.ts:159-195).
VERDICT:  PASS

### DW-3.5
PREMISE:  non-UUID or nonexistent-file id → typed rejection (NO command constructed for a malicious id); herdr live-id with no file does not break `listSessions`.
EVIDENCE: src/necromancy/core.ts:91 (anchored `UUID_RE`, no `m` flag — `${U1}\n` cannot pass), 253-258 (gate 1: regex before anything else; hostile id neutralized via `JSON.stringify(sessionId.slice(0,80))` in the message), 262-270 (gate 2: on-disk stat before any herdr call), 275 (the ONLY `claude --resume` string construction — after both gates AND after workspaceCreate), 228 (listSessions: disk drives the list; a live id merely never matches)
TRACE:    `"x; rm -rf ~"` → fails UUID_RE at line 253 → `NecromancyError("invalid_session_id")` thrown; lines 262-290 (stat, workspaceCreate, paneRun, command template) never execute. Executed test iterates 8 hostile ids (`x; rm -rf ~`, `$(whoami)`, backtick injection, UUID+`; echo pwned`, UUID+`\n`, near-UUID with `Z`, `--help`, `""`) against a tracking client and asserts `calls === []` — zero herdr calls (`DW_3_5_non_uuid_id_rejected_before_any_command_is_constructed`, core.test.ts:429-452). Valid UUID with no file → `NecromancyError("session_not_found")`, zero herdr calls (`DW_3_5_uuid_with_no_ondisk_file_rejected_typed_before_any_herdr_call`). Live id U2 with no file → listSessions returns only on-disk U1, `live:false` (`DW_3_5_live_id_without_file_does_not_break_listSessions`).
VERDICT:  PASS

### DW-3.6
PREMISE:  the three necromancy tools registered with I/O schemas, present in `tools/list` on the real server.
EVIDENCE: src/tools/necromancy.ts:14-38; src/server.ts:39; test/server.test.ts:83-95
TRACE:    `registerNecromancyTools` registers `necromancy_find_spaces` ({}), `necromancy_list_sessions` ({space: z.string()}), `necromancy_revive` ({sessionId: z.string(), cwd: z.string()}) via the registerTool harness → server.ts wires them into the real entry point → the real server, spawned over stdio, answers tools/list containing all three names (executed test `DW_3_6_necromancy_tools_appear_in_the_real_servers_tools_list` speaks real MCP JSON-RPC to `bun run src/server.ts`). Input schemas asserted defined per tool (`DW_3_6_three_necromancy_tools_present_with_input_schemas`, tools.test.ts:34-44); handlers exercised through registration incl. NecromancyError → isError (tools.test.ts:46-112).
VERDICT:  PASS — with a note: no formal MCP `outputSchema` is registered (the Phase-1 registerTool harness, a given contract, has no outputSchema seam); output shapes are conveyed via typed core interfaces + tool descriptions. See Notes.

### DW-3.7
PREMISE:  unit tests cover slug edge cases (dotted/hidden paths), ranking, miss case, malformed jsonl, oversized file, subagent-dir exclusion, create-failure, and non-UUID rejection (stubbed FS + client — no real ~/.claude/projects, no live herdr).
EVIDENCE: test/necromancy/core.test.ts (23 tests), test/necromancy/preview.test.ts (9 tests), test/necromancy/tools.test.ts (5 tests)
TRACE:    slug dotted/hidden (`/a/.hidden/.b.c`, `/a/b.c.d/e`, `my.app`, literal dashes) ✓; ranking (mtime desc) ✓; miss cases (detection timeout → detected:false; UUID with no file; live id with no file) ✓; malformed jsonl ✓; oversized file (stat-gated, content never read) ✓; subagent-dir exclusion ✓; create-failure (workspaceCreate AND paneRun) ✓; non-UUID rejection (8 hostile ids, zero-call assertion) ✓. Isolation: all FS via `mkdtemp` fixture injected as `projectsRoot` (core.test.ts:101-107) — the real `~/.claude/projects` is never the default in any test; all herdr via stub/tracking clients whose unstubbed methods throw. All 37 ran and passed in Step 0.
VERDICT:  PASS

**All requirements met:** YES

## Test-DW Coverage
- [x] All DW items have corresponding automated tests (DW-ID-named, ran in Step 0)
- [x] Stated level (100% of unit-testable code) met for all phase-3 primary files: core.ts, preview.ts, tools/necromancy.ts, registry.ts all 100% funcs/lines
- **Gap:** src/herdr/client.ts lines 286-289 — the in-scope workspaceCreate addendum's second error variant (`root_pane` present but `pane_id` missing/non-string) — are uncovered (94.91% file lines). The variant IS unit-testable: I executed a scratch probe with an injected runner returning `result.root_pane: {}` and observed the correct typed `HerdrError("invalid_response", "...expected result.root_pane.pane_id to be a string...")`. Behavior is correct; only coverage is missing. (client.ts 54-60, also uncovered, is `bunHerdrRunner` — the real `Bun.spawn` process boundary, not unit-testable by design and pre-existing Phase-2 code.) Recommended fix: one client.test.ts case with `root_pane: {}` in the stub envelope.

## Dead Code
None found. No unused imports (tsc clean), no unreachable code, no debug statements (the only console output is intentional stderr logging in registry.ts/server.ts), no commented-out blocks.

## Correctness Dimensions
| Dimension | Status | Evidence |
|-----------|--------|----------|
| Concurrency | PASS | No module-level mutable state in core.ts; every call builds locals. Concurrent revives each create their own workspace and poll independently — traced, no shared-state case found. |
| Error Handling | PASS | Adversarial trace: ENOENT is discriminated from other fs errors at every fs call (core.ts:102-104, 126-128, 139-140, 154-156, 188-190, 265-269) — permission errors stay loud, deletions mid-scan skip. HerdrError from agentList/workspaceCreate/paneRun propagates typed (executed tests). Thrown errors become isError tool results, never stdout (registry.ts:64-76, executed via tools.test + raw-stdout server test). |
| Resources | PASS | Promise-based fs API (no handles to leak); the poll loop's injected/default sleep resolves and the loop always returns (bound proven by the 4-polls/3-sleeps test); no timers or processes left dangling. |
| Boundaries | PASS | Traced: empty file (size 0) gated; file at exactly maxSessionBytes included (`<=`); `files[0]?.mtimeMs ?? null` on empty space; preview clipped at exactly 120 (test asserts length 120 + ellipsis); empty-string sessionId rejected; `slice(0,80)` safe on short ids; empty `cwd` workspace skipped in the join (executed test). |
| Security | PASS | Injection guard scrutinized hard: UUID_RE is `^...$`-anchored without `m` (trailing-`\n` bypass executed-tested and rejected); validation precedes ALL command construction and ALL herdr calls (only `claude --resume` template is line 275, after both gates — zero-call assertion executed for 8 hostile ids incl. `x; rm -rf ~`, `$(whoami)`, backticks); UUID charset `[0-9a-f-]` is shell-inert; hostile id in the error message is JSON.stringify-neutralized; client spawns argv arrays (`Bun.spawn(["herdr", ...argv])`), no `sh -c`; `cwd` never survives as a path-traversal vector into the graveyard (deriveSlug maps both `/` and `.` to `-`, so `../` cannot survive slugging) and is fenced by gate 2 (the slugged dir must already contain the UUID file). |

## Loaded-Skill Criteria
| Skill | Criterion | Status | Evidence |
|-------|-----------|--------|----------|
| aposd-designing-deep-modules | Deep module: small interface hiding substantial complexity | PASS | createNecromancy exposes 3 methods hiding graveyard layout + slug rule, jsonl parsing, stat-gated skip policy, live-join, UUID barricade, and the bounded poll. deriveSlug exported separately but reused by tests and documented as the one slug rule. |
| aposd-designing-deep-modules | No pass-through/shallow layers | PASS | tools/necromancy.ts handlers are one-call registrations by design; response shaping and error normalization live in the registerTool harness, not duplicated per tool. |
| aposd-designing-deep-modules | Silent-failure red flag: failures surfaced, not swallowed | PASS | Skipping malformed/empty/oversized sessions is the DW-3.3-specified policy (an error strategy, not a swallow); non-ENOENT fs errors and HerdrError stay loud (executed test `DW_3_3_a_herdr_failure_surfaces_as_a_typed_HerdrError_not_all_dead`); detection timeout surfaces as `detected:false`, an observable state, not silence. |
| cc-defensive-programming | External input validated at entry (barricade) | PASS | sessionId (untrusted, shell-adjacent) validated at the core barricade — strict UUID regex, then on-disk existence — BEFORE any command string or herdr call; executed zero-call test for 8 hostile ids. Barricade sits in core.ts, so it holds even if a future caller bypasses the MCP layer. |
| cc-defensive-programming | No empty catch blocks | PASS | Every catch either rethrows non-ENOENT (core.ts:126-128, 139-140, 154-156, 188-190, 265-269) or implements the documented, requirement-mandated skip policy with a comment (core.ts:174-175, preview.ts:50-51). None silently swallow unexpected errors. |
| cc-defensive-programming | Assertions for bugs only / no executable code in assertions | N/A | No assertions used; all anticipated-runtime conditions use error handling, which matches the table (external input → error handling). |
| cc-defensive-programming | Security-critical path: defense in depth | PASS | sessionId is checked at the zod tool boundary (string) AND re-validated in core (UUID + disk) — two layers; the hostile id is additionally neutralized in the error message. |

## Notes (non-blocking)
- **Coverage gap on the in-scope addendum** (detailed under Test-DW Coverage): client.ts:286-289 uncovered; behavior demonstrated correct by an executed probe, so this is a coverage-level shortfall (stated bar: "100% of unit-testable code"), not a defect. One trivial test closes it. Flagged for the orchestrator to weigh; under this review's verdict rules an undemonstrated-defect coverage gap is not itself a blocker.
- **DW-3.6 "I/O schemas":** no formal MCP `outputSchema` is registered — the Phase-1 registerTool harness (a given contract per the dispatch) only accepts `inputSchema`, and the necromancy tools use it exactly as designed (no misuse). Output shapes are typed (`SpaceInfo`/`SessionInfo`/`ReviveResult`) and documented in tool descriptions. If the plan intended formal `outputSchema` in tools/list, that requires a harness addendum analogous to the sanctioned `rootPaneId` one — raising for the orchestrator rather than failing phase 3 on a contract it was told to treat as given.
- `pollIntervalMs: 0` (constructor-injected option, never set by production code — server.ts uses defaults) would loop forever since `elapsed` never grows; a programmer-bug guard (assert/clamp) would be cheap. Undemonstrated in any reachable configuration.
- `findSpaces` returns the raw slug as `cwd` for an empty, non-live space (lossy-slug degradation) — documented in code and covered by an executed test; a consumer treating that value as a real path would misfire. Matches the requirement as written.
- `revive`'s `cwd` is fenced by gate 2 (slugged dir must already contain the UUID file) rather than validated directly — consistent with the DW spec, and no traversal survives `deriveSlug`; noting for completeness on the security-sensitive phase.

## Issues (if FAIL)
None.

**Verdict: PASS**
