# Review: Phase 4 - Necromancy skill + live e2e (re-review)

## Executed Results (Step 0)
- `bun test` (full suite, plain, no env flags): `92 pass, 1 skip, 0 fail, 270 expect() calls, 93 tests across 9 files` (880ms). The 1 skip is the live-session describe block in `test/e2e/revive.test.ts`.
- `bun test test/e2e/revive.test.ts` (isolated): `2 pass, 1 skip, 0 fail, 6 expect() calls` (14ms) — confirms the live block is skipped, not merely fast.
- `bun test test/herdr/client.test.ts` (isolated): `36 pass, 0 fail, 84 expect() calls`.
- `bun test test/necromancy/core.test.ts` (isolated): `20 pass, 0 fail, 67 expect() calls` — includes `DW_3_2_missing_projects_root_returns_empty_no_crash`.
- Typecheck: `bunx tsc --noEmit` → clean, zero output.
- Lint: no lint script in `package.json`; not applicable.
- `validate_skill` on `skills/necromancy` → `{"valid":true,"errors":[],"warnings":[],"info":[]}`.
- `test_triggers` on `skills/necromancy` → 16/20 pass (see Loaded-Skill Criteria).
- Side-effect probe: `ls ~/.claude/projects | wc -l` → **999 before, 999 after** plain `bun test` — byte-for-byte identical directory listing (`diff` clean).
- `herdr status` on this machine during the run: exit 0, server running (herdr genuinely up) — meaning the routine-run test above ran with herdr available and still produced zero live side effects.
- `HERDERP_E2E_LIVE` was left **unset** for the routine run (not opted in).

## Focus verification: the live-e2e opt-in gate

`test/e2e/revive.test.ts:60-63`:
```
const liveOptIn = process.env.HERDERP_E2E_LIVE === "1";
const herdrUp = liveOptIn && (await isHerdrUp());
describe.skipIf(!herdrUp)(...)
```
`herdrUp` short-circuits on `liveOptIn` before ever probing herdr — with the flag unset, `isHerdrUp()` isn't even called, and the describe block is skipped unconditionally regardless of herdr's real state. This is exactly the fix the prior review demanded (it had found only `describe.skipIf(!herdrUp)` with no flag, so any dev machine with herdr running — this tool's normal steady state — went live on every plain `bun test`).

Empirical confirmation, not just code reading: herdr **was** up (`herdr status` exit 0) and `HERDERP_E2E_LIVE` **was** unset, and the routine run still produced `1 skip` and zero `~/.claude/projects` diff. This is the specific adversarial condition the old code would have failed (herdr-up + no-flag → old code ran live; new code skips). Confirmed fixed.

Per instructions, the live path itself was not re-run; the prior review (`2026-07-09-herderp-plugin-necromancy-phase-4-review.md`, read as input) already recorded a real live execution before the fix was applied to the gate: "the 'start -> kill -> revive' test ran for 28.1s with 8 assertions, all green — not a skip," including assertions on `result.sessionId`, `result.detected === true`, and the revived pane's `agentRead` output containing the original marker. That run is the functional-correctness evidence for DW-4.3; this re-review's job was only to verify the gating fix, which is now confirmed both by code and by the empirical herdr-up/no-flag probe above.

**Pre-existing debris note (not caused by this review):** four leftover directories from that prior live run(s) still exist on this machine: `~/.claude/projects/-private-var-folders-dy-...-herderp-necro-e2e-{A2O1CS,WzgDbL,dqjGgF,uVpj3L}`. These predate this review session (my own `bun test` run left the directory listing byte-identical, 999→999) and are outside this phase's DW items, but are flagged here for the user's awareness/cleanup since they're real artifacts in the user's actual Claude Code graveyard.

## Requirement Fulfillment

### DW-4.1
PREMISE:  `skills/necromancy/SKILL.md` valid frontmatter (name = dir "necromancy", third-person description with triggers + near-miss exclusions), passes `validate_skill` with zero errors.
EVIDENCE: `skills/necromancy/SKILL.md:1-4`
TRACE:    `name: necromancy` (line 2) matches directory `skills/necromancy`. Description (line 3) is third person throughout ("Finds, previews, and revives..."), states triggers ("Use when the user wants to bring back, resurrect, resume, restore, or find a lost or previous Claude Code session or agent...") and near-miss exclusions ("Not for starting a brand-new Claude Code session from scratch, general herdr workspace/pane/tab management with no revival intent..., or reviving non-Claude agent CLIs (unsupported in v1)"). `validate_skill` executed against the directory: `{"valid":true,"errors":[],"warnings":[],"info":[]}`.
VERDICT:  PASS

### DW-4.2
PREMISE:  body accepts a flexible target (workspace id / label / cwd / session / none) and, when none, calls `necromancy_find_spaces` and presents candidates; then list → preview → pick → `necromancy_revive`.
EVIDENCE: `skills/necromancy/SKILL.md:12-29`
TRACE:    Step 1 (12-19): "The user may point at a space by workspace id, a label, a project cwd, something that names a session directly, or nothing at all" → "Call `necromancy_find_spaces` first, always"; no-target branch presents returned spaces and asks; target-given branch matches case-insensitively against cwd/label/workspaceId with explicit zero-match (fall back to full list, never guess), one-match (proceed), and multi-match (list + ask, never silently pick first) sub-branches; a session-shaped target shortcuts to step 2. Step 2 (21-23) calls `necromancy_list_sessions({ space: <cwd> })`, handles the empty-list case, presents newest-first with preview/count/live flag. Step 3 (25) is the pick, with an already-live collision warning. Step 4 (27-29) calls `necromancy_revive({ sessionId, cwd })` and reports `detected: true/false` honestly, without claiming false success. This is natural-language prose interpreted by an LLM at runtime, not executable code — no automated test can exercise it; verified by direct reading against the required flow (a desk-checkable spec assertion, per Step 2 of the skill-craft review protocol).
VERDICT:  PASS

### DW-4.3
PREMISE:  live e2e exists and, when opted in, starts a throwaway `claude` session, kills it, revives through the tools, and confirms the same session id reattaches with prior context. (Test logic + build's recorded live evidence checked; not re-run live.)
EVIDENCE: `test/e2e/revive.test.ts:63-165`; prior review doc `2026-07-09-herderp-plugin-necromancy-phase-4-review.md:24-28`
TRACE:    Logic walk: `workspaceCreate` (81) → `paneRun("claude")` (95) → 5s settle → `paneRun(MARKER prompt)` (97) → poll `agentList` until `agent_status` is `working`/`done`, with a resend-once fallback for a prompt dropped by a still-booting TUI (100-113) → capture + UUID-shape-validate `sessionId` (114-116) → read the on-disk `.jsonl` directly and assert it contains `MARKER` **before** any kill (121-124) → `paneClose` (129, the kill) → poll until the agent disappears from `agentList` (133-136) → assert the `.jsonl` still contains `MARKER` **after** the kill (140-141) → call the real `createNecromancy({ client, ... }).revive({ sessionId, cwd })` (145-146, the actual production path, not a stub) → assert `result.sessionId === sessionId` and `result.detected === true` (148-149) → assert `agentRead` on the revived pane contains `MARKER` (156-157, prior context present). `finally` (158-161) always closes the pane and removes the temp dir. Recorded live evidence (prior review, executed before the gating fix): this exact test ran for real, 28.1s, 8 assertions, all green — confirming the logic above is not just plausible on paper but was observed to pass against real herdr + real `claude`.
VERDICT:  PASS

### DW-4.4
PREMISE:  herdr-down and no-projects cases produce a clear message not a crash; AND a routine `bun test` (no opt-in flag) is side-effect-free — spawns no live session, creates no pane, writes nothing to `~/.claude/projects`.
EVIDENCE: `test/e2e/revive.test.ts:167-205`, `src/necromancy/core.ts:184-193`, `test/necromancy/core.test.ts:171-178`
TRACE:
- herdr-down, `findSpaces`: stubbed runner throws `ECONNREFUSED...` (168-172) → `client.findSpaces()` → `spawnHerdr` catches the throw → `HerdrError("spawn_failed", ...)`. Test asserts `instanceof HerdrError`, `code === "spawn_failed"`, message contains `"herdr"`, message does NOT contain `"undefined is not a function"` (174-184). Ran: pass.
- herdr-down, `revive` (after disk gates pass): seeds a real session file in a temp `projectsRoot` so the UUID + on-disk-file gates in `core.ts:253-270` pass first, then `client.workspaceCreate` throws via the same `spawnHerdr` path → `HerdrError("spawn_failed")` (186-205). Ran: pass.
- No-projects: `core.ts:184-193` — `readdir(projectsRoot)` throwing `ENOENT` is caught by `isEnoent` and returns `[]`, not a throw (a missing graveyard is treated as "no spaces," never a crash). Test `DW_3_2_missing_projects_root_returns_empty_no_crash` (`core.test.ts:171-178`) exercises this directly against a `does-not-exist` path with a `stubClient()` that would throw on any herdr call (proving the empty-graveyard path never even reaches herdr). Ran: pass.
- Side-effect-free routine run: verified above — `~/.claude/projects` entry count and listing identical before/after plain `bun test` (999/999, `diff` clean), with herdr genuinely running and the opt-in flag genuinely unset.
VERDICT:  PASS

**All requirements met:** YES

## Test-DW Coverage
- [x] DW-4.1 — tool-verified (`validate_skill`), non-code item.
- [x] DW-4.2 — recorded observed behavior (desk-checked prose against the required flow); no automated test possible for natural-language skill body.
- [x] DW-4.3 — automated test (live e2e, `test/e2e/revive.test.ts`), with real assertions on session id, disk survival, and revived content; functional pass recorded live by the prior review; gating logic re-verified this session.
- [x] DW-4.4 — automated tests: herdr-down (`revive.test.ts:174-205`), no-projects (`core.test.ts:171-178`), side-effect-free routine run (empirical `~/.claude/projects` diff, this session).
- Coverage matches the dispatch's stated level (execution evidence for every DW item, no gaps).

## Dead Code
None found in the four reviewed files. No `console.*` debug statements, no `TODO`/`FIXME`, no commented-out blocks. `revive.test.ts` imports are all used (`mkdir`, `mkdtemp`, `readFile`, `realpath`, `rm`, `writeFile`, `homedir`, `tmpdir`, `join`, `createHerdrClient`, `HerdrRunner`, `createNecromancy`, `HerdrError`). No unreachable code after early returns (`runHerdrVoid`/`paneRun` are single straight-line paths; `waitFor`'s loop has one exit per iteration, no dead branch after).

## Correctness Dimensions
| Dimension | Status | Evidence |
|-----------|--------|----------|
| Concurrency | N/A | No shared mutable state across concurrent calls in the reviewed files; `revive`'s poll loop and the e2e test's `waitFor` are both sequential, single-flight. |
| Error Handling | PASS | Traced `paneRun` on a nonzero exit with no JSON body (`client.test.ts:248-257`, stderr `"pane not found"`): `throwOnNonZeroExit` finds no JSON envelope, falls to `stderr.trim()`, throws `HerdrError("command_failed", "herdr pane run w9:p1 echo hi: pane not found")` — ran, passed. Herdr-down paths (above) normalize a runner throw to `spawn_failed` uniformly. |
| Resources | N/A | No file handles/connections/locks owned by `client.ts`; each `herdr` invocation is a one-shot spawn with awaited exit. The e2e test's own resources (temp dir, pane) are released in a `finally` regardless of outcome. |
| Boundaries | PASS | Traced the empty-stdout success case: `paneRun("w3:p1", "claude --resume <uuid>")` with stub `ok("")` (exitCode 0, stdout `""`) → `runHerdrVoid` → `spawnHerdr` (no throw) → `throwOnNonZeroExit` (exitCode===0, returns immediately, no JSON parse attempted) → resolves `undefined`. Regression test `DW_2_1_paneRun_tolerates_empty_stdout_on_success_live_herdr_behavior` (`client.test.ts:240-246`) exercises exactly this — ran in isolation this session (`test/herdr/client.test.ts`: 36 pass, 0 fail) — and is the actual fix for the bug the live e2e originally surfaced (old code routed `paneRun` through the JSON-requiring `runHerdr`, which threw `invalid_response` on every real revive despite the old fabricated-JSON stub making the unit suite pass). |
| Security | N/A for this phase's diff | `paneRun`'s `command` argument is untrusted-input-adjacent, but the UUID validation barricade lives in `src/necromancy/core.ts` (unchanged this phase, reviewed in Phase 3); `client.ts` passes `command` as one `Bun.spawn` argv element, never shell-interpolated — unchanged behavior. |

## Additional scope: `paneRun` fix verification (carried forward)
Confirmed still holding: `paneRun(paneId, command): Promise<void>` is textually unchanged in the `HerdrClient` interface (`src/herdr/client.ts:48`). It succeeds on empty stdout (traced above) and still normalizes real failures identically to every other method (`spawnHerdr` for a runner that never starts → `spawn_failed`; `throwOnNonZeroExit` for a nonzero exit → herdr's own JSON error code verbatim, or `command_failed` with stderr/stdout detail). The regression test (`client.test.ts:240-246`) uses a distinct, minimal `ok("")` fixture (not a rename of the old fabricated-JSON stub, which is still present as a separate, now-redundant-but-harmless test at `client.test.ts:226-232`) and is explicitly commented as the bug's regression test. Ran in isolation this session: 36/36 pass.

## Loaded-Skill Criteria

| Skill | Criterion | Status | Evidence |
|-------|-----------|--------|----------|
| oberskills:skill-craft | Deterministic floor — `validate_skill` zero errors/warnings | PASS | `{"valid":true,"errors":[],"warnings":[],"info":[]}`. |
| oberskills:skill-craft | `name` matches directory, no banned substrings/hyphen issues | PASS | `name: necromancy`, dir `necromancy` — exact match. |
| oberskills:skill-craft | Description: third person, no XML tags, within char limits, capability nouns not process steps | PASS | Third person throughout; no XML tags; `description_chars: 679` (well under 1024 cap); describes what/when, not the internal 4-step sequence (that lives only in the body). |
| oberskills:skill-craft | Triggers — `test_triggers` should/shouldn't accuracy | **WARN** | 16/20 pass (80%). 4 near-miss (should-NOT-trigger) queries mistriggered: 3 at 2/3 runs (borderline, small-sample noise) and one at **3/3 (100%)** — "My aider session for the backend repo died when I lost wifi — can you help me get back into that coding session" — which directly probes the skill's own stated exclusion ("Not for... reviving non-Claude agent CLIs (unsupported in v1 — Claude sessions only)") and mistriggered every run. This is a real discoverability defect in the description, not a functional/security bug: the skill body's own "Scope (v1)" line and `necromancy_find_spaces`'s Claude-Code-only graveyard scan mean a mistaken trigger cannot cause an incorrect action (no aider session exists in `~/.claude/projects` to revive) — worst case is a confusing "no matches" response. Graded WARN rather than FAIL: no DW item names trigger precision, and the failure mode is a routing/UX nuisance, not an incorrect result or crash. Recommend running `optimize_description` as a follow-up to tighten the exclusion wording (e.g. naming "aider"/other agent CLIs explicitly, since the current phrase "non-Claude agent CLIs" apparently isn't lexically strong enough to suppress the match). |
| oberskills:skill-craft | Body size — <500 lines hard / ~200-line core-relevance norm | PASS | 40 lines (`validate_skill` stat: `skill_md_lines: 40`). |
| oberskills:skill-craft | Gates beat persuasion — degraded-state handling reads as external checks, not self-assessed compliance | PASS | "Degraded environments" section states two concrete, externally observable conditions (herdr unreachable → typed error; missing `~/.claude/projects` → empty list) and the exact response for each — no "use good judgment" language, no anti-rationalization table, no compliance checklist. |
| oberskills:skill-craft | Supply chain — no bundled scripts/network calls in the skill directory | PASS (N/A) | `skills/necromancy/` contains only `SKILL.md`; no bundled scripts. |
| oberskills:prompt | No over-prescription (MUST/CRITICAL/anti-laziness scaffolding) | PASS | Plain declarative instructions ("Call X first, always", "never guess a cwd that wasn't returned") — firm but not shouty; no `MUST`/`CRITICAL`/all-caps scaffolding, no "show your reasoning" instruction (Fable 5 refusal risk), no prefill. |
| oberskills:prompt | Rationale precedes the instruction it justifies | PASS | E.g. "reviving it again would launch a second, duplicate `claude --resume`... rather than reattaching to the one already running" precedes "confirm before continuing" (line 25). |

## Notes (non-blocking)
- Four leftover `~/.claude/projects/*herderp-necro-e2e-*` directories exist on this machine from prior live runs (predating this review session — my own routine `bun test` left the directory listing byte-identical). Not caused by, or cleanable from within, this repo's test suite; flagged for the user's own cleanup.
- `client.test.ts:226-232` (`DW_2_1_paneRun_spawns_pane_run_with_paneId_and_command`) still stubs a fabricated JSON success body for `paneRun`, redundant now that `runHerdrVoid` ignores stdout content on exit 0 — harmless, no functional impact, just a leftover pre-fix test alongside the new regression test.
- Trigger-accuracy WARN above (aider near-miss) is worth a follow-up `optimize_description` pass but does not block this phase.

## Issues (if FAIL)
None — no blocking issues found.

**Verdict: PASS.** The specific fix under review (explicit `HERDERP_E2E_LIVE=1` opt-in, in addition to the herdr-up probe, gating the live e2e block) is confirmed both by code reading and by an empirical adversarial probe (herdr genuinely up, flag genuinely unset, plain `bun test` produced `1 skip` and a byte-identical `~/.claude/projects` before/after). All four DW items pass with execution evidence, the carried-forward `client.ts` `paneRun` empty-stdout fix still holds (36/36 unit tests green), and no dead code or unhandled listed edge case was found. One non-blocking WARN: `skills/necromancy`'s near-miss trigger exclusion for non-Claude agent CLIs (e.g. aider) is not lexically strong enough and mistriggered 3/3 in `test_triggers` — recommend a follow-up `optimize_description` pass, not a re-review blocker.
