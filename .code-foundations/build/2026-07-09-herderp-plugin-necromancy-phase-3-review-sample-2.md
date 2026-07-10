# Review: Phase 3 - Necromancy core + tools (sample 2)

Independent post-gate review. Security-sensitive phase; injection guard scrutinized by code trace AND executed hostile-input tests.

## Executed Results (Step 0)
- Test suite: `bun test` → **87 pass, 0 fail** (256 expect() calls, 8 files)
- Typecheck: `bunx tsc --noEmit` → **clean (exit 0)**
- Lint: no lint command configured in the dispatch or project; not run
- Coverage: `bun test --coverage` → all necromancy files (core.ts, preview.ts, tools/necromancy.ts) **100% funcs / 100% lines**; `src/herdr/client.ts` **97.44% funcs / 94.91% lines, uncovered 54-60 and 286-289** (see Issues)

## Requirement Fulfillment

### DW-3.1
PREMISE:  `deriveSlug(cwd)` maps each `/` and `.` → `-` (`/Users/r/repos/herderp/.necrotest` → `-Users-r-repos-herderp--necrotest`).
EVIDENCE: src/necromancy/core.ts:34-36 (`cwd.replace(/[/.]/g, "-")`)
TRACE:    `/Users/r/repos/herderp/.necrotest` → 5 `/` and 1 `.` each become `-` → `-Users-r-repos-herderp--necrotest` (the `/.` pair yields the double dash). Executed: `DW_3_1_derives_the_verified_necrotest_slug` passes, plus dotted/hidden/multidot/dash/empty cases (core.test.ts:80-96).
VERDICT:  PASS

### DW-3.2
PREMISE:  `findSpaces()` enumerates the projects root, joins with live workspaces by cwd, returns cwd/label/sessionCount/lastActivity per space.
EVIDENCE: src/necromancy/core.ts:184-219
TRACE:    readdir(projectsRoot) → directory entries → `client.workspaceList()` builds slug→workspace map (empty-cwd workspaces skipped, first-listed wins on duplicates, lines 198-203) → per dir: scanSessionFiles (mtime-desc), cwd = live workspace cwd ?? cwd recovered from a session line ?? raw slug → `{cwd,label,workspaceId,sessionCount,lastActivity}`. Executed: `DW_3_2_findSpaces_joins_disk_and_live_workspaces` (joined space gets label "alpha"/w1, non-live space's cwd recovered from session lines, lastActivity = newest mtime), `DW_3_2_..._degrades_to_the_raw_slug`, `DW_3_2_tolerates_empty_cwd_workspaces_and_duplicate_cwds` — all pass.
VERDICT:  PASS

### DW-3.3
PREMISE:  `listSessions(cwd)` enumerates `<slug>/*.jsonl`, ranks by mtime desc, marks live vs dead (via agentList), adds preview + messageCount, excludes nested `subagents/`, skips malformed/empty/oversized files without crashing.
EVIDENCE: src/necromancy/core.ts:122-149, 221-247; src/necromancy/preview.ts:20-41
TRACE:    scanSessionFiles reads only direct children (`readdir` withFileTypes, `entry.isFile()` — no recursion, so `subagents/` is excluded by construction; non-UUID names skipped), sorts mtimeMs desc → size gate (`size > 0 && size <= maxSessionBytes`, stat-only — oversized never read) → readFile → parseSessionPreview (null for fully-malformed → skipped) → `live: liveIds.has(id)` from one agentList call. Executed: `DW_3_3_ranks_by_mtime_desc_and_marks_live_vs_dead` ([U2,U3,U1], live flags [false,true,false]), `DW_3_3_skips_malformed_empty_and_oversized_jsonl` (oversized has VALID content over an injected 200-byte cap, proving the stat gate fires instead of a read), `DW_3_3_excludes_nested_subagents_dir_and_non_uuid_filenames`, plus 9 preview.test.ts cases — all pass.
VERDICT:  PASS

### DW-3.4
PREMISE:  `revive(sessionId,cwd)` validates the UUID, creates a workspace, runs `claude --resume <id>` via `paneRun` on the created workspace's rootPaneId, waits (bounded) for detection, returns `{workspaceId,paneId,sessionId,detected}`; workspace/pane create failures surface as a typed error, not a partial-state crash.
EVIDENCE: src/necromancy/core.ts:249-291; src/herdr/client.ts:273-295 (rootPaneId addendum)
TRACE:    UUID gate (line 253) → on-disk stat gate (262-270) → `workspaceCreate({cwd})` → `paneRun(workspace.rootPaneId, \`claude --resume ${sessionId}\`)` → poll loop: elapsed accumulates in pollIntervalMs units, exits with detected:false when `elapsed + pollIntervalMs > detectTimeoutMs` (100ms/300ms config → exactly 4 polls, 3 sleeps). HerdrError from create/run propagates uncaught (typed). Executed: `DW_3_4_revive_creates_workspace_runs_claude_resume_and_returns_the_detected_agent` (asserts paneRun got `["w9:p1", "claude --resume <U1>"]` and that the DETECTED agent's pane w9:p2 wins over the created ids), `DW_3_4_detection_never_arrives_bounded_wait_returns_detected_false` (polls===4, sleeps===3 — deterministic bound, no hang, no throw), `DW_3_4_default_sleep_is_a_real_timer_between_polls`, `DW_3_4_workspaceCreate_failure_surfaces_typed_and_paneRun_is_never_reached`, `DW_3_4_paneRun_failure_surfaces_typed_without_a_partial_state_crash`; client.test.ts `DW_3_4_workspaceCreate_surfaces_rootPaneId_from_the_create_envelopes_root_pane` — all pass.
VERDICT:  PASS

### DW-3.5
PREMISE:  non-UUID or nonexistent-file id → typed rejection (NO command constructed for a malicious id); herdr live-id with no file does not break `listSessions`.
EVIDENCE: src/necromancy/core.ts:91, 253-270 (gates); 228 (disk-authoritative live join)
TRACE:    Code path: `UUID_RE.test(sessionId)` at line 253 is the FIRST statement of revive — the `claude --resume` string literal does not exist until line 275, after both gates; the rejected id is rendered inert in the error via `JSON.stringify(sessionId.slice(0,80))`. `$` in a JS regex without `m` does not match before a trailing `\n`, so `"<uuid>\n"` is rejected too (and is in the executed hostile set). Executed: `DW_3_5_non_uuid_id_rejected_before_any_command_is_constructed` runs 8 hostile ids — `x; rm -rf ~`, `$(whoami)`, `` `touch /tmp/pwned` ``, `<uuid>; echo pwned`, `<uuid>\n`, near-UUID with `Z`, `--help`, `""` — each yields `NecromancyError{code:"invalid_session_id"}` with a tracking client asserting **calls === []** (zero herdr calls). `DW_3_5_uuid_with_no_ondisk_file_rejected_typed_before_any_herdr_call` → `session_not_found`, zero calls. `DW_3_5_live_id_without_file_does_not_break_listSessions` → disk-only result, live:false. All pass.
VERDICT:  PASS

### DW-3.6
PREMISE:  the three necromancy tools registered with I/O schemas, present in `tools/list` on the real server.
EVIDENCE: src/tools/necromancy.ts:14-38; src/server.ts:39; test/server.test.ts:83-95
TRACE:    `registerNecromancyTools` registers necromancy_find_spaces / necromancy_list_sessions (`{space: z.string()}`) / necromancy_revive (`{sessionId: z.string(), cwd: z.string()}`) through the Phase-1 `registerTool` harness; server.ts wires it with `createNecromancy({client})`. Executed: `DW_3_6_necromancy_tools_appear_in_the_real_servers_tools_list` spawns the REAL server over stdio via the SDK client and finds all three in `tools/list`; tools.test.ts verifies input schemas, handler passthrough, and NecromancyError → isError. All pass. (Output shape is documented in descriptions and typed in core; no formal MCP outputSchema — see Notes.)
VERDICT:  PASS

### DW-3.7
PREMISE:  unit tests cover slug edge cases (dotted/hidden paths), ranking, miss case, malformed jsonl, oversized file, subagent-dir exclusion, create-failure, and non-UUID rejection (stubbed FS + client — no real ~/.claude/projects, no live herdr).
EVIDENCE: test/necromancy/core.test.ts (18 tests), test/necromancy/preview.test.ts (9), test/necromancy/tools.test.ts (5), test/herdr/client.test.ts DW_3_4 cases
TRACE:    slug dotted/hidden ✓ (core.test.ts:85-95); ranking ✓ (:203); miss cases ✓ (missing root :171, unknown space :275, live-id-no-file :261, uuid-no-file :454); malformed jsonl ✓ (:225 + preview.test.ts:54-64); oversized ✓ (:225, injected 200-byte cap); subagent exclusion ✓ (:245); create-failure ✓ (:391); non-UUID rejection ✓ (:429). FS isolation: every test injects a `mkdtemp` fixture as `projectsRoot` — the real `~/.claude/projects` is never touched; herdr isolation: stub/tracking clients whose unstubbed methods throw. All 87 tests executed and pass.
VERDICT:  PASS

**All requirements met:** YES (behaviorally) — but the stated Test Coverage Level is not met; see Issues.

## Test-DW Coverage
- [x] All DW items have corresponding tests, named with DW ids, ran in Step 0
- [ ] Coverage matches the stated level (**100% of unit-testable code**): necromancy files are at 100/100, but the in-scope `workspaceCreate` rootPaneId addendum leaves **client.ts:286-289 uncovered** — the guard for `root_pane` present but `pane_id` missing/malformed. The test named `DW_3_4_workspaceCreate_throws_invalid_response_when_root_pane_pane_id_is_missing` (client.test.ts:179) actually omits `root_pane` entirely, so `unwrapResult` (line 284) throws first and the addendum's own guard never executes; the test passes for the wrong reason (both messages contain "root_pane"). I proved the branch is unit-testable and behaves correctly with an executed scratch test (`root_pane: {tab_id}` → `invalid_response` mentioning `root_pane.pane_id` — 1 pass).
- client.ts:54-60 (`bunHerdrRunner`, the real Bun.spawn adapter) is also uncovered — pre-existing Phase 2 code, not unit-testable without a live process; justified, not a blocker.

## Dead Code
None found. No unused imports (tsc clean), no unreachable code, no debug statements, no commented-out blocks in the reviewed files.

## Correctness Dimensions
| Dimension | Status | Evidence |
|-----------|--------|----------|
| Concurrency | PASS | No shared mutable state; TOCTOU races traced: file deleted between readdir and stat → ENOENT skip (core.ts:140); deleted between stat and readFile → null skip (core.ts:155). Sequential poll loop, one agentList per listSessions. |
| Error Handling | PASS | ENOENT policies explicit and asymmetric by design (missing root → [], missing session file → typed rejection); non-ENOENT FS errors and HerdrError stay loud (core.ts:128, executed test `DW_3_3_a_herdr_failure_surfaces_as_a_typed_HerdrError_not_all_dead`). Tool layer converts throws to isError (executed). |
| Resources | PASS | readFile/stat/readdir hold no handles; oversized files stat-gated so a multi-GB jsonl is never loaded (executed with valid-content-over-cap fixture); default sleep timer always resolves. |
| Boundaries | PASS | Traced `cwd=""`: slug `""` → join(root,"") scans projectsRoot itself → no `.jsonl` UUID files → []; revive stats `root/<uuid>.jsonl` → session_not_found. Empty preview, empty file, 120-char clip (executed, exact-length assert), `slice(0,80)` on hostile id safe for short strings. |
| Security | PASS | Barricade traced line-by-line: UUID regex (core.ts:91) is `^…$`-anchored, hex+dash only, no metacharacter can pass; JS `$` rejects trailing-`\n` payloads (in the executed hostile set). Command string is constructed only at line 275, after both gates; executed tests assert ZERO herdr calls for 8 hostile ids. `cwd` cannot traverse: `deriveSlug` maps `/` and `.` to `-` before joining, and gate 2 requires a real session file under that slug before any herdr call; spawn is argv-array (client.ts:55), no shell layer in this codebase. Hostile id rendered inert in error text via JSON.stringify. |

## Loaded-Skill Criteria
| Skill | Criterion | Status | Evidence |
|-------|-----------|--------|----------|
| aposd-designing-deep-modules | Deep module / interface depth | PASS | 3-method core hides graveyard layout, slug rule, jsonl parsing, size-gate policy, UUID validation, command construction, and the detection poll; tool layer is 3 one-line handlers (tools/necromancy.ts:20,28,36). |
| aposd-designing-deep-modules | Information hiding / leakage | PASS | Slug rule lives in one function; skip policy in one place (withinSizeGate + parseSessionPreview); callers need zero knowledge of ~/.claude/projects internals. |
| aposd-designing-deep-modules | Silent-failure red flag | PASS | Skipping malformed/oversized files silently IS the DW-3.3 requirement; genuine failures (herdr down, permission errors) surface typed and loud (core.ts:128, 227). |
| cc-defensive-programming | External input validated at entry | PASS | sessionId validated before the barricade crossing (both gates before any herdr call — executed zero-call tests); cwd traversal-neutralized by the slug map and disk gate; security-critical path gets defense in depth (regex + disk). |
| cc-defensive-programming | No empty catch blocks swallowing bugs | PASS | Every catch either rethrows non-ENOENT (core.ts:126-129, 139-141, 154-157, 263-270) or implements the documented, requirement-backed skip policy with a comment (core.ts:174, preview.ts:50). |
| cc-defensive-programming | Assertions vs error handling | PASS | Anticipated runtime conditions (missing files, malformed jsonl, herdr failures) use error handling, never assertions; no executable code in assertions (none used). |

## Notes (non-blocking)
- `pollIntervalMs <= 0` would make revive's poll loop unbounded (`elapsed` never grows past `detectTimeoutMs`). Internal config only — the MCP surface can't reach it and the default is 500ms — but a one-line floor/assert in `createNecromancy` would be cheap insurance.
- `findSpaces` `sessionCount` counts all UUID `.jsonl` files including empty/oversized ones that `listSessions` will skip, so the two tools can disagree on the count for the same space. No DW specifies which is right.
- DW-3.6 says "I/O schemas": input schemas are formal (zod); output shape is only in descriptions + core TypeScript types — the given Phase-1 `registerTool` harness has no outputSchema support, so a formal MCP outputSchema would need a harness extension. Flagged as interpretation, not a defect.
- `messageCount` counts every `user`-typed line, including tool_result-carrier user messages in real Claude sessions, so counts may read high vs "conversational messages". Unspecified semantics; matches the tested contract.
- Slug collisions (`/tmp/proj-a` vs `/tmp/proj.a`) are inherent to Claude Code's own lossy scheme and documented in the code (core.ts:26-33); no security consequence (no command injection possible; workspaceCreate cwd is argv-passed).

## Issues (FAIL blockers)
1. Stated Test Coverage Level ("100% of unit-testable code") unmet on in-scope addendum code: the `workspaceCreate` rootPaneId guard branch is never executed by the suite.
   - File: src/herdr/client.ts:286-289 (uncovered per `bun test --coverage`)
   - Demonstrated by: coverage report (`src/herdr/client.ts … Uncovered Line #s 54-60,286-289`) + an executed scratch test proving the branch is unit-testable and correct (envelope with `root_pane: {tab_id}` and no `pane_id` → `HerdrError{code:"invalid_response"}` mentioning `root_pane.pane_id`; 1 pass). Root cause: `DW_3_4_workspaceCreate_throws_invalid_response_when_root_pane_pane_id_is_missing` (test/herdr/client.test.ts:179-195) omits the `root_pane` key entirely, so `unwrapResult` at client.ts:284 throws before the guard; the test's `"root_pane"`-substring assertion passes against the wrong error site.
   - Fix: add (or repoint the mislabeled test to) a case whose envelope contains `root_pane` without a string `pane_id`, asserting the `root_pane.pane_id` message. (Lines 54-60, the real-spawn adapter, are not unit-testable and pre-date this phase — no action.)

**Verdict: FAIL — one blocker: in-scope, unit-testable addendum branch (client.ts:286-289) uncovered, violating the dispatch's stated 100%-of-unit-testable-code coverage level; all seven DW items and all listed edge cases otherwise PASS with execution evidence.**
