# Discovery + Design: Phase 3 - Necromancy core + tools

## Files Found
- `src/registry.ts` — Phase 1 `registerTool(server, {name, description, inputSchema, handler})` harness (zod shapes, error→isError normalization, stderr-only logging).
- `src/herdr/client.ts` — Phase 2 `HerdrClient` (10 methods) + injectable `HerdrRunner`; internal-only `firstPaneCwd` uses `pane list --workspace` but discards `pane_id`.
- `src/herdr/types.ts` — pinned seam types `Agent{agent,sessionId,status,cwd,workspaceId,tabId,paneId}`, `Workspace{id,label,cwd,tabCount,paneCount}`, `Session`, `HerdrError{code,message}`.
- `src/tools/curated.ts`, `src/server.ts` — 9 curated tools registered; server wires curated tools only.
- `test/herdr/*.test.ts`, `test/registry.test.ts`, `test/server.test.ts` — bun:test; stub-`HerdrClient` and stub-runner patterns; `_registeredTools` introspection for tools/list assertions; DW-named test cases.
- None of this phase's files exist yet: `src/necromancy/**`, `src/tools/necromancy.ts`, `test/necromancy/**` are greenfield.

## Current State
Phases 1–2 delivered exactly the seams this phase consumes: `registerTool` and a typed `HerdrClient` with `workspaceList/agentList/workspaceCreate/paneRun/agentWait`. 50 tests green. Phase 2's live-verified corrections honored in this design: no `--json` except `session list`; `Workspace.cwd` derives from the first pane and may be `""`.

## Gaps

### GAP-1 (BLOCKING, drives UPDATE_PLAN): revive cannot obtain a paneId through the pinned seam
DW-3.4 pins the composition `workspaceCreate → paneRun('claude --resume <id>') → agentWait`, and the Produces contract requires returning `{workspaceId, paneId, sessionId, detected}`. But:

- `herdr pane run <pane_id> <command>` takes a **strict pane_id** (usage probed read-only 2026-07-09; no `--pane/--current` alternate form, unlike sibling subcommands).
- The pinned `Workspace` seam (`src/herdr/types.ts:23`) has **no pane id** — only `{id, label, cwd, tabCount, paneCount}` — and `HerdrClient` (`src/herdr/client.ts:36-47`) exposes **no pane-discovery method** (`firstPaneCwd` is private and returns only `cwd`).
- The only pinned source of a `paneId` is `Agent.paneId`, which exists only **after** herdr detects an agent — but `paneRun` is what launches the agent. Chicken-and-egg. Exhaustively checked all 10 client methods; no assumption-free composition exists.

**Evidence the fix is one field away** — live `herdr workspace create` envelope (captured 2026-07-09 during discovery; see Probe disclosure below) contains the root pane id that Phase 2's `mapWorkspaceFields` currently drops:

```json
{"id":"cli:workspace:create","result":{
  "root_pane":{"pane_id":"wK:p1","tab_id":"wK:t1","workspace_id":"wK","cwd":"/Users/r/repos/upublish", ...},
  "workspace":{"workspace_id":"wK","pane_count":1,"tab_count":1, ...},
  "type":"workspace_created"}}
```

**Proposed plan corrections (ranked):**
1. **(Recommended)** Sanction a minimal Phase 2 seam addendum in `src/herdr/**` (outside this phase's file scope — precedent: the Phase 2 review sanctioned a `src/server.ts` touch): add `rootPaneId?: string` to `Workspace` (or a `WorkspaceCreated` return type for `workspaceCreate` only), mapped from `result.root_pane.pane_id`, + one client test. ~10 lines; no other seam consumer affected (`workspaceList` leaves it undefined).
2. Sanction deriving `paneId = \`${workspace.id}:p1\`` inside the necromancy core. Rejected as default: relies on herdr's id-format convention observed once (wK → wK:p1) — unverifiable without prohibited live mutations, and embeds herdr id internals in the necromancy module (information leakage). Failure would at least be loud (`paneRun` → typed `HerdrError`), and the detected `Agent.paneId` would correct the return value on success, but it's a guess at the core of a security-sensitive orchestration path.
3. Add a full `paneList(workspaceId)` client method. Works but heavier than needed.

### GAP-2 (minor, same UPDATE_PLAN): DW-3.6 needs a one-line `src/server.ts` wiring touch
Phase 3's file scope omits `src/server.ts`, but the three tools must be registered on the **real** server to be "present in tools/list" — Phase 2 was failed in review for exactly this omission and the fix was an orchestrator-sanctioned `src/server.ts` touch. Request the same sanction up front: `registerNecromancyTools(server, createNecromancy({ client }))` in `main()`.

### Non-blocking discovery corrections (absorbed into the design)
- `~/.claude/projects/*` directory names are **slugs**, and slug→cwd reversal is lossy (`-` may mean `/`, `.`, or a literal `-`). `findSpaces` must therefore recover each space's `cwd` from (a) the live-workspace join (slug(ws.cwd) == dirname) or (b) the `cwd` field present on session `.jsonl` lines — verified present in the real store (read-only spot check). Fallback when both fail: surface the raw slug as `cwd` (degraded, documented).
- Preview assumption (Med confidence) resolved: **direct jsonl parse chosen** — real files carry `{"type":"summary","summary":...}` lines and `{"type":"user","message":{content}}` lines sufficient for a one-line preview + message count. `herdr agent explain --file` fallback not needed (would add a live-herdr dependency to a pure-FS path).

## Code Standards
No `docs/code-standards.md` in the repo. Followed the de-facto Phase 1–2 conventions instead: factory functions over classes (`createHerdrClient`), typed `<Name>Error extends Error {code}`, injectable process/FS boundaries, header comments naming the deep-module rationale, stderr-only logging, `.js` ESM import suffixes.

## Test Infrastructure
`bun:test` (describe/it/expect). Patterns to reuse: stub `HerdrClient` object literal with overrides (test/herdr/curated.test.ts); `_registeredTools` cast for tools/list presence; DW-IDs embedded in test names (`DW_3_1_...`). New for this phase: temp fixture dir as injectable `projectsRoot` (created under the test's tmp scratch, never the real `~/.claude/projects`); injected `sleep`/timeout knobs so detection-polling tests run instantly.

## DW Verification

| DW-ID | Done-When Item | Status | Test Cases |
|-------|---------------|--------|------------|
| DW-3.1 | `deriveSlug(cwd)` maps each `/` and `.` → `-` | COVERED | `test_DW_3_1_derives_the_verified_necrotest_slug` (exact fixture from plan), `test_DW_3_1_slug_handles_hidden_dotted_and_multidot_paths`, trailing-slash + literal-dash cases |
| DW-3.2 | `findSpaces()` enumerates projects root, joins live workspaces by cwd, returns cwd/label/sessionCount/lastActivity | COVERED | `test_DW_3_2_findSpaces_joins_disk_and_live_workspaces`, `test_DW_3_2_findSpaces_space_with_no_sessions`, `test_DW_3_10_missing_projects_root_returns_empty_no_crash`, empty-cwd / duplicate-cwd workspace tolerance |
| DW-3.3 | `listSessions(cwd)` ranks mtime desc, live/dead via agentList, preview+messageCount, excludes `subagents/`, skips malformed/empty/oversized | COVERED | `test_DW_3_3_ranks_by_mtime_desc_and_marks_live_vs_dead`, `test_DW_3_3_skips_malformed_empty_and_oversized_jsonl` (oversized skipped by stat, content never read — injected small maxSessionBytes), `test_DW_3_3_excludes_nested_subagents_dir` |
| DW-3.4 | `revive` validates UUID → create → paneRun → bounded wait → seam object; create/run failures → typed error | CANNOT_MEET (as pinned) | GAP-1: no pane id obtainable from the pinned `workspaceCreate`/`HerdrClient` seam to pass to `paneRun`. Design + tests fully specified below (happy path, `detected:false` timeout, workspaceCreate/paneRun failure passthrough) — implementable immediately once GAP-1's correction is sanctioned |
| DW-3.5 | non-UUID / nonexistent-file id → typed rejection; live-id with no file doesn't break listSessions | COVERED (design) — rejection tests are revive tests, blocked only by GAP-1's phase gate | `test_DW_3_5_non_uuid_id_rejected_before_any_command_is_constructed` (spy paneRun asserts zero calls, injection strings incl. `x; rm -rf ~`), `test_DW_3_5_uuid_with_no_ondisk_file_rejected_typed`, `test_DW_3_5_live_id_without_file_does_not_break_listSessions` |
| DW-3.6 | three tools registered with I/O schemas, present in tools/list | COVERED (needs GAP-2 sanction for the real-server wiring) | `test_DW_3_6_three_necromancy_tools_present_with_input_schemas`, per-tool handler passthrough tests |
| DW-3.7 | unit tests cover slug edges, ranking, miss case, malformed jsonl, non-UUID rejection (stubbed FS + client) | COVERED | The union of the above — all against a temp fixture projectsRoot + stub HerdrClient; zero live herdr calls, zero reads of the real `~/.claude/projects` |

**All items COVERED:** NO — DW-3.4 CANNOT_MEET as pinned (GAP-1). Count: 7/7 DW-IDs mapped.

## Design Decisions

### Design: necromancy core (design-it-twice)

#### Approaches Considered
1. **Factory** — `createNecromancy({client, projectsRoot?, ...})` returning `{findSpaces, listSessions, revive}`; `deriveSlug` exported as a pure function. Deps injected once; matches `createHerdrClient` convention.
2. **Free functions with explicit deps** — `findSpaces(deps)`, `listSessions(deps, cwd)`, `revive(deps, req)`; every caller threads a deps object.
3. **Necromancer class** — constructor DI, methods otherwise identical to 1.

#### Comparison
| Criterion | 1 Factory | 2 Free fns | 3 Class |
|-----------|---|---|---|
| Interface simplicity | 1 factory + 3 methods + 1 pure fn | 4 fns, deps arg on every call | same as 1, plus class ceremony |
| Information hiding | deps/FS/polling fully hidden after construction | deps shape leaks to every call site (tools file) | same as 1 |
| Caller ease of use | tools file holds one object | tools file re-threads deps ×3 | `new` vs project's factory idiom |
| Consistency with Phases 1–2 | matches `createHerdrClient(runner)` exactly | matches nothing | factories preferred repo-wide |

#### Choice: 1 (Factory), hybrid with pure exported `deriveSlug`
Rationale: identical injection story to Phase 2 (tests hand a stub client + a temp projectsRoot once), smallest tool-file surface, and `deriveSlug` stays a pure exported function because DW-3.1 tests it directly and Phase 4's skill may want it standalone. Sacrifice: none material; free functions only win if callers needed per-call dep variation, which nothing does.

#### Depth Check
- Interface methods: 3 (+1 pure fn, +1 error class)
- Hidden details: slug rule, graveyard directory layout + `subagents/` exclusion, jsonl line formats (summary/user/assistant shapes), size caps and skip policy, mtime ranking, live-join via agentList, UUID validation, `claude --resume` command construction, detection polling cadence/deadline
- Common case complexity: simple — a tool handler is one method call returning the plan's exact output shape

### Interface (pinned to the plan's Produces)
```ts
// src/necromancy/core.ts
export function deriveSlug(cwd: string): string;              // each "/" and "." → "-"; no path libs
export class NecromancyError extends Error { readonly code: "invalid_session_id" | "session_not_found"; }
export interface NecromancyOptions {
  client: HerdrClient;
  projectsRoot?: string;        // default: join(homedir(), ".claude", "projects"); tests: temp fixture
  maxSessionBytes?: number;     // default 32 MiB; stat-gated — oversized files skipped, never read
  detectTimeoutMs?: number;     // default 15_000; bounded detection wait
  pollIntervalMs?: number;      // default 500
  sleep?: (ms: number) => Promise<void>; // injectable so timeout tests run instantly
}
export interface SpaceInfo   { cwd: string; label: string | null; workspaceId: string | null; sessionCount: number; lastActivity: number | null; }
export interface SessionInfo { id: string; cwd: string; mtime: number; live: boolean; preview: string; messageCount: number; }
export interface ReviveResult{ workspaceId: string; paneId: string; sessionId: string; detected: boolean; }
export function createNecromancy(opts: NecromancyOptions): {
  findSpaces(): Promise<SpaceInfo[]>;
  listSessions(cwd: string): Promise<SessionInfo[]>;
  revive(req: { sessionId: string; cwd: string }): Promise<ReviveResult>;
};

// src/necromancy/preview.ts
export function parseSessionPreview(text: string): { preview: string; messageCount: number } | null; // null = malformed → skip

// src/tools/necromancy.ts
export function registerNecromancyTools(server: McpServer, necromancy: Necromancy): void;
// necromancy_find_spaces {} · necromancy_list_sessions {space} · necromancy_revive {sessionId, cwd}
```

### Key decisions (defensive-programming barricade: FS + herdr output are external; validate at entry)
| Decision | Choice | Why |
|---|---|---|
| Injection guard order | `revive`: UUID regex `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i` FIRST, then on-disk file existence, and only then any herdr call; the `claude --resume ${id}` string is constructed after both checks | Security gate: a non-UUID id must never reach `paneRun`; test spies assert zero client calls for malicious ids |
| Slug rule | Character map over the raw string (`[/.]` → `-`), no `path` normalization | Plan-verified rule; path libs collapse `..`/dots |
| findSpaces cwd recovery | live-workspace join first (skip `cwd===""`, first-listed wins on duplicates), else `cwd` field from the newest readable session line, else the slug itself | Slug reversal is lossy; jsonl lines carry `cwd` (verified) |
| Oversized/empty/malformed jsonl | `stat` gate: size 0 or > maxSessionBytes → skip file (never read); unparseable content (no usable lines) → skip | DW-3.3 "skips…without crashing"; oversized never loaded at all |
| Preview | first `summary` line's `.summary`, else first `user` message text (string or `[{type:"text",text}]`), whitespace-collapsed, ≤120 chars | Direct parse; deterministic; no herdr dependency |
| Session id source | filename stem; non-UUID filenames skipped | Disk is authoritative; malformed names are not sessions |
| live flag | `agentList()` once per `listSessions`, match on `Agent.sessionId`; a live id with no file never breaks enumeration (disk drives the list); `HerdrError` propagates (loud, typed) rather than silently marking all dead | No silent-failure red flag; registerTool renders it as a clear isError |
| Detection wait | poll `agentList` for `sessionId === id` every pollIntervalMs until detectTimeoutMs; timeout → `detected:false` (not an error); on detection return the **detected agent's** workspaceId/paneId (ground truth over the created ones) | Plan-verified detection lag; bounded; honest `detected:false` |
| revive failure surface | `HerdrError` from workspaceCreate/paneRun propagates untouched (typed), `NecromancyError` for validation — no partial-state crash, no rollback (plan requires typed surfacing only) | Matches Phase 2 error architecture |
| Tools layer | thin: zod schemas + one method call each, via Phase 1 `registerTool` | All logic stays in the testable core |

## Prerequisites
- [x] Phase 2 `HerdrClient` + seam types exist and are tested
- [x] Phase 1 `registerTool` harness exists
- [x] Real jsonl store shape confirmed read-only (summary/user lines, `cwd` field, `subagents/` nesting)
- [ ] **MISSING:** a pinned-seam path from `workspaceCreate` to a `paneRun`-able pane id (GAP-1)
- [ ] **MISSING:** sanction for the one-line `src/server.ts` wiring (GAP-2)

## Probe disclosure
Discovery probes were intended read-only (Phase 2 precedent). One probe — bare `herdr workspace create`, expected to print usage — **actually created workspace wK** (all its args are optional). It was inspected (`pane list --workspace wK`: one fresh shell pane, nothing else) and closed (`workspace close wK` → ok) immediately; prior herdr state restored. Its response envelope is the GAP-1 evidence above. No other mutations; no live revive was run; the real `~/.claude/projects` was only read, never written.

## Recommendation
**UPDATE_PLAN.** DW-3.4 is unmeetable through the pinned Phase 2 seam (GAP-1): `paneRun` demands a pane id that no pinned method can supply before the agent exists, and fabricating `${workspaceId}:p1` from a single live observation would put an unverified format assumption inside the security-sensitive revive path. Requested corrections: (1) sanction the ~10-line Phase 2 seam addendum surfacing `result.root_pane.pane_id` from `workspaceCreate` (evidence captured above) — or explicitly sanction the derivation fallback; (2) add `src/server.ts` to Phase 3's file scope for the one-line tool wiring (Phase 2 review precedent). Everything else is fully designed and test-mapped above; once sanctioned, the build is unblocked with no further discovery needed.

## Implementation

**UPDATE_PLAN resolution:** approved option 1. GAP-1 closed via the sanctioned Phase 2 seam addendum (`workspaceCreate(): Promise<Workspace & {rootPaneId: string}>`, mapped from the create envelope's `result.root_pane.pane_id`); GAP-2 closed via the sanctioned `src/server.ts` wiring.

### Files changed
| File | What |
|---|---|
| `src/herdr/client.ts` | Seam addendum: `workspaceCreate` return type now `Workspace & {rootPaneId: string}`; maps `result.root_pane.pane_id`; missing/non-string `pane_id` → typed `HerdrError("invalid_response")` (revive depends on it — loud, not silent) |
| `src/necromancy/core.ts` | NEW — deep module: `deriveSlug` (pure, char-map, no path normalization), `NecromancyError`, `createNecromancy` factory (`findSpaces`/`listSessions`/`revive`) with injectable `projectsRoot`/`maxSessionBytes`/`detectTimeoutMs`/`pollIntervalMs`/`sleep`. UUID-first + file-existence security gates BEFORE any command construction or herdr call; stat-gated skip (empty/oversized never read); mtime-desc ranking; live join via one `agentList`; lossy-slug cwd recovery (live join → session-line `cwd` → raw slug degraded); bounded detection poll in deterministic sleep-units, timeout → honest `detected:false`; detected agent's ids win over created ids |
| `src/necromancy/preview.ts` | NEW — pure jsonl → `{preview, messageCount} | null` (summary line preferred, user text fallback incl. content-block arrays; whitespace-collapsed ≤120 chars; null = malformed → caller skips) |
| `src/tools/necromancy.ts` | NEW — three thin tool registrations via Phase 1 `registerTool`; all logic stays in the core |
| `src/server.ts` | Sanctioned wiring: shared `createHerdrClient()` instance feeds both `registerCuratedTools` and `registerNecromancyTools(server, createNecromancy({client}))` |
| `test/herdr/client.test.ts` | Existing workspaceCreate fixture upgraded to the real live-captured envelope (adds `root_pane`) + 2 new tests (rootPaneId mapping; missing root_pane → typed error) |
| `test/herdr/curated.test.ts` | Stub client satisfies the new return type (`STUB_CREATED_WORKSPACE`); create-tool expectation includes `rootPaneId` |
| `test/necromancy/core.test.ts` | NEW — 20 tests: slug edges, findSpaces join/degraded/missing-root/dup-cwd, listSessions ranking/skips/subagents-exclusion/live-miss/herdr-failure, revive happy/timeout-bound/default-sleep/create-fail/paneRun-fail/injection-rejection (8 hostile ids, zero client calls asserted)/no-file rejection. Temp-fixture `projectsRoot` (mkdtemp) + stub `HerdrClient` only |
| `test/necromancy/preview.test.ts` | NEW — 8 tests: summary preference, string/array content, clip/collapse, message counting, malformed-only → null, interleaved garbage, empty-preview, later-user fallback |
| `test/necromancy/tools.test.ts` | NEW — 5 tests: three tools with schemas, per-tool passthrough, NecromancyError → isError |
| `test/server.test.ts` | NEW test: three necromancy tools present in a real `tools/list` round-trip (DW-3.6, same precedent as curated) |

### DW → test trace (all COVERED, 7/7)
| DW-ID | Passing tests |
|---|---|
| DW-3.1 | `DW_3_1_derives_the_verified_necrotest_slug`, `..._hidden_dotted_and_multidot_paths`, `..._literal_dashes_and_trailing_slashes` |
| DW-3.2 | `DW_3_2_findSpaces_joins_disk_and_live_workspaces`, `..._space_with_no_sessions_degrades_to_the_raw_slug`, `..._missing_projects_root_returns_empty_no_crash`, `..._tolerates_empty_cwd_workspaces_and_duplicate_cwds` |
| DW-3.3 | `DW_3_3_ranks_by_mtime_desc_and_marks_live_vs_dead`, `..._skips_malformed_empty_and_oversized_jsonl` (oversized has VALID content over an injected cap — exclusion proves the stat gate, not a parse failure), `..._excludes_nested_subagents_dir_and_non_uuid_filenames`, `..._unknown_space_returns_empty_without_touching_herdr`, `..._herdr_failure_surfaces_as_a_typed_HerdrError`, + 8 preview tests |
| DW-3.4 | `DW_3_4_revive_creates_workspace_runs_claude_resume_and_returns_the_detected_agent` (asserts exact `paneRun("w9:p1", "claude --resume <id>")` and that the detected agent's pane wins), `..._detection_never_arrives_bounded_wait_returns_detected_false` (asserts exact poll/sleep counts), `..._default_sleep_is_a_real_timer_between_polls`, `..._workspaceCreate_failure_surfaces_typed_and_paneRun_is_never_reached`, `..._paneRun_failure_surfaces_typed`, + 2 client rootPaneId tests |
| DW-3.5 | `DW_3_5_non_uuid_id_rejected_before_any_command_is_constructed` (8 hostile ids incl. `x; rm -rf ~`, `$(whoami)`, backticks, newline-suffixed UUID; tracking client asserts ZERO herdr calls), `DW_3_5_uuid_with_no_ondisk_file_rejected_typed_before_any_herdr_call`, `DW_3_5_live_id_without_file_does_not_break_listSessions` |
| DW-3.6 | `DW_3_6_three_necromancy_tools_present_with_input_schemas` + 4 passthrough/error tests + `DW_3_6_necromancy_tools_appear_in_the_real_servers_tools_list` (real stdio round-trip) |
| DW-3.7 | Union of the above — all against mkdtemp fixture roots + stub clients; zero live herdr mutations, zero reads of the real `~/.claude/projects` |

### Verification
- `bun test`: **87 pass, 0 fail** (50 Phase 1–2 anchored tests intact + 37 new)
- `bunx tsc --noEmit`: clean
- `bun test --coverage`: `src/necromancy/core.ts` 100/100, `src/necromancy/preview.ts` 100/100, `src/tools/necromancy.ts` 100/100 (funcs/lines)
- No live herdr mutations; tests never touch the real `~/.claude/projects` (server.test.ts only lists tools — no handler executes)

### Deviations from design
- `rootPaneId` expressed as an inline intersection on `workspaceCreate`'s signature (exactly the plan's pinned `Workspace & {rootPaneId: string}`) rather than a field on `Workspace` — `workspaceList` results are unchanged, so no other seam consumer is affected.
- One anchored test's fixture (`DW_2_1_workspaceCreate_...`) was upgraded to the live-captured envelope shape (adds `root_pane`) so it exercises the sanctioned addendum; every original assertion is preserved and one was added. No test weakened or removed.
- Everything else implements the recorded design verbatim.
