# Review: Phase 2 - MCP tools + skill guidance

## Executed Results (Step 0)
- Test suite: `bun test` → 145 pass, 1 skip, 0 fail, 422 expect() calls, 146 tests across 10 files.
- Typecheck: `bunx tsc --noEmit` → clean, no output.
- Skill validation: `validate_skill` on `/Users/r/repos/herderp/skills/necromancy` → `valid: true`, 0 errors, 0 warnings, 0 info.

## Requirement Fulfillment

### DW-2.1
PREMISE:  the three tools (`necromancy_search`, `necromancy_outline`, `necromancy_read`) are registered and appear in `tools/list` with input schemas; each handler is a thin call into the core method (no logic); a call with a bad/absent session surfaces as an `isError` tool result, not a crash.
EVIDENCE: src/tools/necromancy.ts:57-113 (three `registerTool` calls, each handler body is `({ ...(await necromancy.sessionX(args)) })` with zero branching/logic); test/necromancy/tools.test.ts:152-162 (presence+schema), :164-228 (thin-passthrough — received args match input verbatim), :230-248 (thrown `NecromancyError` → `isError: true`, message surfaced, no throw escapes)
TRACE:    `{sessionOutline: throws NecromancyError("session_not_found", ...)}` → handler calls `necromancy.sessionOutline` → registry.ts:64-75 catches, returns `{content:[...], isError:true}` → test asserts `isError === true` and message contains "no session file" — ran and passed.
VERDICT:  PASS

### DW-2.2
PREMISE:  an integration test drives `necromancy_outline` → `necromancy_search` → `necromancy_read` against a fixture session and gets role-tagged, index-linked, capped results end to end.
EVIDENCE: test/necromancy/tools.test.ts:280-369, using a real `createNecromancy({ client: stubClient(), projectsRoot: root })` (no core stubbing) and a hand-written 4-turn JSONL fixture.
TRACE:    outline → `total: 5`, roles `["user","thinking","tool_use","tool_result","text"]`, entry[2].tool === "Bash" → search `{query:"race condition"}` → 1 match, `truncated:false`, `index:4` → read `{from:4}` → `entries:[{index:4, role:"text", text:"found it: a race condition on line 42"}]`, `truncated:false`. Ran and passed (part of the 145-pass run).
VERDICT:  PASS

### DW-2.3
PREMISE:  `SKILL.md` gains a read-a-session section (outline→search→read, read-vs-revive, honest `truncated`/`nextOffset`) and its frontmatter triggers cover reading/getting-up-to-speed; `validate_skill` returns zero errors.
EVIDENCE: skills/necromancy/SKILL.md:31-51 ("Reading a session (get up to speed without reviving)" section: outline→search→read loop at :38-42, read-vs-revive guidance at :36, honest truncated/nextOffset handling at :44); frontmatter description (line 3) includes "reads a past session's actual turns (search, outline, verbatim) in place... to get up to speed on what it did" and "wants to know what happened in a past session, catch up on prior work, see what was tried or discussed before, or search/read old session content without launching it."
TRACE:    `validate_skill(skill_path=/Users/r/repos/herderp/skills/necromancy)` → ran → `{"valid":true,"errors":[],"warnings":[],"info":[]}`.
VERDICT:  PASS

### DW-2.4
PREMISE:  `bun test` green; existing revive tool + skill flow unchanged.
EVIDENCE: `bun test` output — 145 pass, 0 fail; test/necromancy/tools.test.ts:61-141 (`DW-3.6` describe block — find_spaces/list_sessions/revive tool tests, all present and unmodified in intent); skills/necromancy/SKILL.md:10-29 (original revive flow, "Resolve a target to a space" → "List and preview" → "Pick one" → "Revive", intact alongside the new reading section).
TRACE:    Ran `bun test` → 0 fail across all files including the pre-existing DW-3.6 revive-tool suite; no revive-flow assertions changed or removed.
VERDICT:  PASS

**All requirements met:** YES

## Test-DW Coverage
- [x] DW-2.1 → `DW_2_1_three_reader_tools_present_with_input_schemas`, `DW_2_1_necromancy_{outline,search,read}_is_a_thin_passthrough_to_the_core`, `DW_2_1_a_thrown_NecromancyError_from_any_reader_tool_surfaces_as_isError_not_a_crash` (all ran, passed)
- [x] DW-2.2 → `DW_2_2_outline_search_read_integration_over_a_fixture_session_via_the_real_registry` (ran, passed)
- [x] DW-2.3 → `validate_skill` tool run (executed, zero errors) — the only meaningful automated check for a documentation artifact; no automated test tests SKILL.md prose content beyond validation, which is appropriate here
- [x] DW-2.4 → full `bun test` run (145 pass / 0 fail) covers "green"; DW-3.6 suite re-run confirms revive/find_spaces/list_sessions unchanged
- Edge case (reader tools never call herdr) → `stubClient()` throws "unexpected herdr call" for every method; DW-2.2 integration test passed without any such throw firing, i.e., herdr was never invoked
- Edge case (limit/maxBytes ceiling'd at tool layer) → `DW_2_1_an_over_large_requested_limit_or_maxBytes_is_rejected_by_the_input_schema` (ran, passed) — schemas reject `DEFAULT_MAX_*+1`, accept the ceiling value itself
- Edge case (absent session → typed isError) → `DW_2_5_necromancy_read_on_a_non_uuid_sessionId_via_the_registry_surfaces_isError_not_a_crash`, `DW_2_5_necromancy_read_on_an_absent_sessionId_via_the_registry_surfaces_isError_not_a_crash` (ran, passed, real core+registry, not stubbed)

Test coverage matches the stated level (tool-presence + one integration path + dirty tests).

## Dead Code
None found. src/tools/necromancy.ts is entirely thin handlers plus one derived constant (`TURN_ROLES`, used); no unused imports, no unreachable branches, no debug statements, no commented-out code.

## Correctness Dimensions
| Dimension | Status | Evidence |
|-----------|--------|----------|
| Concurrency | N/A | No shared mutable state in this file; each handler is a stateless closure over `necromancy` |
| Error Handling | PASS | registry.ts:64-75 catches any thrown error (typed `NecromancyError` or otherwise) and converts to `isError:true`, verified by both stub-level and real-integration tests |
| Resources | N/A | No file handles/connections/locks opened in this layer — delegated to core.ts (out of scope per dispatch) |
| Boundaries | PASS | Traced adversarial input `limit: DEFAULT_MAX_OUTLINE_ENTRIES + 1` → zod `.max()` rejects before handler runs (verified by executed test); `limit: 0` rejected by `.min(1)`; non-integer rejected by `.int()` |
| Security | N/A | sessionId/cwd validation (UUID check, path containment) is core.ts's contract, explicitly out of scope for this phase per dispatch instructions; tool layer correctly does not attempt to duplicate it |

## Loaded-Skill Criteria

| Skill | Criterion | Status | Evidence |
|-------|-----------|--------|----------|
| oberskills:skill-craft | Description formula `[Verb-first capabilities]. Use when [...]. Not for: [...]` | PASS | SKILL.md:3 opens "Finds, previews, and revives...", has "Use when the user wants to...", closes with "Not for starting a brand-new Claude Code session..., general herdr workspace/pane/tab management..., or reviving non-Claude agent CLIs..." |
| oberskills:skill-craft | Third-person description (injected into system prompt) | PASS | SKILL.md:3 entirely third-person ("Finds, previews, and revives a previous Claude Code agent session...") |
| oberskills:skill-craft | Frontmatter/body hard limits (name ≤64 chars, body <500 lines, description ≤1024 chars) | PASS | validate_skill stats: `skill_md_lines: 55`, `description_chars: 992`; name `necromancy` matches directory name |
| oberskills:skill-craft | No CRITICAL/MUST over-prompting, no anti-rationalization tables, gates over persuasion | PASS | Scanned full SKILL.md body — no CRITICAL/MUST/ALWAYS-style forcing language; guidance is explanatory ("say why"), not coercive |
| oberskills:prompt | Positive framing / explain-why over "don't" lists | PASS | SKILL.md:44 "Honor truncated/nextOffset honestly" explains the reasoning (caps exist, more may remain) rather than issuing a bare prohibition |
| oberskills:prompt | Governance/task separation, reasoning before answer where applicable | N/A | Skill body is a procedural doc, not a model-output schema with rationale/answer fields — criterion doesn't apply to this artifact shape |

## Notes (non-blocking)
- `necromancy_outline`'s `offset` param has `.min(0)` but no `.max()` ceiling; not required by DW-2.1's edge case (which names only `limit`/`maxBytes`), and an oversized offset alone can't produce an oversized response, so this is not a gap against the stated requirement — flagged only as an observation.
- The stub-level "thrown NecromancyError from any reader tool" test (test/necromancy/tools.test.ts:230-248) only exercises `necromancy_outline` directly; `necromancy_search`/`necromancy_read`'s error path is confirmed generically via the shared `registerTool` wrapper (registry.ts:64-75) plus `necromancy_read`'s own real-integration bad/absent-session tests (DW-2.5) — coverage is sufficient but not perfectly symmetric across all three reader tools individually.

## Issues (if FAIL)
None.

**Verdict: PASS**
