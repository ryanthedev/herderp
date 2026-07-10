# Review: Phase 1 - Session-reader core (sample 1)

## Executed Results (Step 0)
- Test suite: `bun test` → 136 pass, 1 skip, 0 fail (137 tests, 10 files). Stderr error lines are expected-rejection tests, not failures.
- Typecheck: `bunx tsc --noEmit` → exit 0, no errors.
- Lint: none configured (per dispatch).
- Coverage: `bun test --coverage` → src/necromancy/reader.ts 100% funcs / 99.46% lines (no uncovered line listed); src/necromancy/core.ts 100% / 100%.
- Adversarial probes executed via `bun -e` (multibyte boundaries maxBytes 2–8, exact-char-boundary cut, maxSpan=0, Unicode special-casing) — results cited below.

## Requirement Fulfillment

### DW-1.1
PREMISE:  "`parseTurns` maps a real fixture jsonl to ordered role-tagged entries — user text, assistant `thinking`, assistant `text`, each `tool_use` (with tool name), each `tool_result` — with stable 0-based `index` in file order; `isSidechain` and meta/malformed records excluded."
EVIDENCE: src/necromancy/reader.ts:155-181 (parseTurns), 111-140 (turnsFromContent), 77-89 (parseRecord skip), 162 (isSidechain), 172-173 (meta skip); tests reader.test.ts:47-170.
TRACE:    fixture jsonl (user string + assistant [thinking,text,tool_use] + user [tool_result]) → parseTurns splits lines, parseRecord drops malformed/non-object, isSidechain===true and non-user/assistant types skipped, blocks flattened → roles ["user","thinking","text","tool_use","tool_result"], indexes [0..4], tool_use carries tool:"Bash", tool_result recovers "Bash" via toolNameByUseId.
VERDICT:  PASS — tests DW_1_1_parses_all_role_kinds_in_file_order, DW_1_1_excludes_sidechain_and_meta_records, DW_1_1_skips_malformed_lines_without_crashing (+6 more DW_1_1 tests) all pass in Step 0.

### DW-1.2
PREMISE:  "`outlineTurns` returns one line per entry (index, role, tool?, clipped text), honors `filter` (e.g. `tool_use` yields only tool calls), and caps/pages via `limit`+`offset` with a correct `total` and `nextOffset`."
EVIDENCE: src/necromancy/reader.ts:196-211; tests reader.test.ts:181-227.
TRACE:    10 turns, {limit:4, offset:0} → filter (none) → slice(0,4) → entries [0..3], total 10, nextOffset 4; offset 8 → entries [8,9], nextOffset null; {filter:"tool_use"} over mixed roles → indexes [1,3], total 2; 200-char text clipped to ≤100 with "…".
VERDICT:  PASS — DW_1_2_outline_lists_index_role_tool_and_clipped_preview, DW_1_2_filter_narrows_to_tool_use_only, DW_1_2_limit_and_offset_page_with_correct_total_and_nextOffset, DW_1_2_empty_turns_yields_empty_outline pass.

### DW-1.3
PREMISE:  "`searchTurns` finds case-insensitive lexical matches, returns each with `index`+`role`+`tool?`+bounded snippet, caps at `limit`, and sets `truncated` when more matched."
EVIDENCE: src/necromancy/reader.ts:228-270 (searchTurns), 219-225 (buildSnippet ≤160 chars); tests reader.test.ts:233-280.
TRACE:    "flux capacitor" over ["please FIX the Flux Capacitor", tool_use "grep flux capacitor.ts"] → toLowerCase().indexOf match in both → 2 matches with index/role/tool/snippet, truncated false; 5 matching turns with limit 2 → 2 matches, truncated true (loop breaks past limit only after detecting a further match, reader.ts:257-260).
VERDICT:  PASS — DW_1_3_case_insensitive_match_returns_index_role_tool_and_snippet, DW_1_3_limit_caps_results_and_sets_truncated, DW_1_3_no_match, regex-mode and invalid-regex-fallback tests pass.

### DW-1.4
PREMISE:  "`readTurns` returns verbatim entry content for `[from,to]`, enforces both span and byte caps, and sets `truncated` when a cap cut the output. The byte cap is HARD — a returned response must never exceed maxBytes, including when the cap lands mid-multibyte-character, and truncation must not introduce a U+FFFD replacement char."
EVIDENCE: src/necromancy/reader.ts:281-329 (readTurns), 332-344 (truncateToBytes); tests reader.test.ts:286-393.
TRACE:    "ab😀cd" (8 bytes, 😀 spans bytes 2-5) with maxBytes 4 → entryBytes 8 > remaining 4 → truncateToBytes: subarray(0,4)=[a,b,F0,9F] → strip continuation 9F, strip lead F0 → "ab" (2 bytes), no U+FFFD, truncated true. Executed probe sweep maxBytes 2–8: every result ≤ cap, zero U+FFFD. Span: 20 turns, maxSpan 5 → entries [0..4], truncated true. to<from → {entries:[], truncated:false}.
VERDICT:  PASS — DW_1_4_hard_byte_cap_holds_at_a_multibyte_boundary, DW_1_4_a_single_entry_exceeding_the_byte_cap_is_truncated_in_place, DW_1_4_span_cap_truncates_and_flags, DW_1_4_byte_cap_truncates_and_flags, exact-fit and exact-exhaustion tests all pass, plus my executed probe sweep. (Over-trim quirk at exact char boundaries — safe-side, see Notes.)

### DW-1.5
PREMISE:  "`sessionSearch`/`sessionOutline`/`sessionRead` reject a non-UUID `sessionId` with a typed `NecromancyError` and construct no filesystem path for it (assert via injected FS that no read is attempted); an absent file → `session_not_found`; an oversized file is stat-gated and never read."
EVIDENCE: src/necromancy/core.ts:330-357 (loadTurns: UUID_RE test at :331 precedes `join` at :338; stat at :341 precedes readFile at :352; size gate at :348); tests reader.test.ts:466-534.
TRACE:    sessionId "x; rm -rf ~" via injected mkdtemp projectsRoot → UUID_RE fails → NecromancyError code "invalid_session_id" thrown before line 338 constructs any path (an attempted stat would instead have yielded "session_not_found" since no file exists — the distinct code proves no FS op ran). Valid UUID, no file → stat ENOENT → "session_not_found". 500-byte valid file with maxSessionBytes:100 → size gate at :348 throws "session_not_found" without readFile.
VERDICT:  PASS — 9 tests (3 methods × non-UUID/absent/oversized: DW_1_5_*_rejects_non_uuid_sessionId_before_any_read, DW_1_5_*_absent_file_is_session_not_found, DW_1_5_*_oversized_file_is_stat_gated_never_read) pass; malicious-id set includes shell metachars, `$(whoami)`, UUID+newline, "--help", "".

### DW-1.6
PREMISE:  "caps are enforced from `NecromancyOptions` defaults and overridable; a synthetic huge session never yields a response exceeding the byte cap."
EVIDENCE: src/necromancy/core.ts:80-87 (options), 139-142 (defaults), 365/375/387 (wired into calls); tests reader.test.ts:536-579.
TRACE:    300-turn session, default options → sessionOutline returns exactly 200 entries (DEFAULT_MAX_OUTLINE_ENTRIES), nextOffset 200; {maxOutlineEntries:3} → 3 entries; 500 turns × ~2KB with {maxReadBytes:4096, maxReadSpan:1000}, from 0 to 499 → summed entry bytes ≤ 4096, truncated true.
VERDICT:  PASS — DW_1_6_default_caps_apply_when_unspecified, DW_1_6_caps_overridable_via_options, DW_1_6_huge_session_response_never_exceeds_the_byte_cap pass.

### DW-1.7
PREMISE:  "`bun test` green; `revive`/`findSpaces`/`listSessions` and their tests unchanged."
EVIDENCE: `bun test` → 136 pass / 0 fail. `git status`: only src/necromancy/core.ts and test/necromancy/tools.test.ts modified; test/necromancy/core.test.ts (the revive/findSpaces/listSessions tests) untouched. `git diff HEAD -- src/necromancy/core.ts` shows purely additive hunks (imports, 4 cap options, loadTurns + 3 session* methods, extended return object at :390) — revive (:278-320), findSpaces (:213-248), listSessions (:250-276) bodies byte-identical. tools.test.ts diff adds only type-satisfying stubs for the three new methods; existing tests unmodified.
TRACE:    HEAD-vs-worktree diff → zero hunks inside revive/findSpaces/listSessions; suite including core.test.ts's DW-3.x tests passes.
VERDICT:  PASS

**All requirements met:** YES

## Test-DW Coverage
- [x] Every DW item maps to named tests that ran in Step 0 (DW_1_1_* ×9, DW_1_2_* ×4, DW_1_3_* ×5, DW_1_4_* ×11, DW_1_5_* ×9, DW_1_6_* ×3). DW-1.7's "unchanged" half is a spec assertion no automated test can exercise — covered by recorded observed behavior (git diff walk above); its "green" half is the executed suite.
- [x] Coverage matches the stated level: reader.ts 100% funcs / 99.46% lines (coverage report names no uncovered line), core.ts 100%/100%.

## Edge Cases (prompt-listed)
| Edge case | Handling | Evidence |
|---|---|---|
| non-UUID sessionId → typed rejection before path constructed | UUID_RE at core.ts:331 precedes join at :338 | 3× DW_1_5 rejection tests, malicious-id set |
| absent → session_not_found; empty/oversized → stat-gated, not read | core.ts:341-350 (stat + size===0/oversize gate before readFile) | DW_1_5 absent + oversized tests; empty file hits size===0 branch at :348 |
| malformed/partial jsonl skipped; bare-string vs block-array content; tool_result block-array content | reader.ts:77-89, 116-119, 143-152 | DW_1_1_skips_malformed, DW_1_1_handles_bare_string_and_block_array, DW_1_1_tool_result_content_as_block_array_is_joined |
| tool_use structured input → bounded text | reader.ts:101-103 serialized; bounded by clip (outline :206) / snippet (:224) / byte cap (read :303-325) at every response surface | DW_1_1 tool_use test + cap tests |
| read from/to out of range clamped; to<from → empty | reader.ts:284, 287-288 | DW_1_4_out_of_range_from_to_clamped, DW_1_4_to_less_than_from |
| count AND byte caps per response, incl. multibyte boundary | reader.ts:290, 296-326, 332-344 | DW_1_4 multibyte test + executed probe sweep maxBytes 2-8 (all ≤ cap, no U+FFFD); maxSpan:0 probe → {entries:[], truncated:true} |

## Dead Code
None found. No unused imports, unreachable code, debug statements, or commented-out blocks in the four files.

## Correctness Dimensions
| Dimension | Status | Evidence |
|-----------|--------|----------|
| Concurrency | N/A | reader.ts is pure functions over in-memory arrays; core session* methods hold no shared mutable state across calls (toolNameByUseId is per-parseTurns-call, reader.ts:156) |
| Error Handling | PASS | Traced: malformed JSON → null skip (:83-84); invalid regex → literal fallback (:236); ENOENT → typed session_not_found, non-ENOENT rethrown loud (core.ts:342-347); no empty catches — every catch handles or rethrows |
| Resources | PASS | fs/promises readFile/stat only — no handles, locks, or streams held open; oversized files never loaded (core.ts:348) |
| Boundaries | PASS | Probed: empty turns, empty text, to<from, from/to out of range, maxSpan 0 (→ empty + truncated:true), exact byte fit, exact budget exhaustion, cap mid-4-byte char — all correct |
| Security | PASS | UUID barricade before any path construction (core.ts:331 vs :338); path-traversal payloads ("x; rm -rf ~", "$(whoami)", UUID+"\n") rejected with zero FS ops; hostile id JSON.stringify-inerted and length-capped in the error message (:334) |

## Loaded-Skill Criteria
| Skill | Criterion | Status | Evidence |
|-------|-----------|--------|----------|
| aposd-designing-deep-modules | Deep interface / information hiding | PASS | Necromancy factory: 6 methods hiding graveyard layout, jsonl schema, stat-gate policy, caps; reader: 4 pure functions; caller's common case is one call with defaults |
| aposd-designing-deep-modules | No silent-failure red flag | PASS | Every cap cut surfaced via `truncated`/`nextOffset`; gated files surface as typed session_not_found; skip policies are documented contract, not swallowed failures |
| aposd-designing-deep-modules | No information leakage / pass-through | PASS | reader knows nothing of FS; core knows nothing of block shapes; maxSpan documented as server-side-only knob (reader.ts:276) |
| cc-defensive-programming | External input validated at entry (barricade) | PASS | sessionId (untrusted) validated at loadTurns entry before path join; file content treated as untrusted — never crashes on garbage (DW_1_1_skips_malformed, non-object JSON-line test) |
| cc-defensive-programming | No empty catch blocks | PASS | All catches act: parseRecord returns null per documented skip contract (:83-84), regex falls back (:236), FS catches rethrow non-ENOENT (core.ts:157, 169, 185, 342) |
| cc-defensive-programming | Assertions for bugs only / anticipated errors handled | PASS | No assertions in production paths; all anticipated runtime conditions (malformed input, missing files, oversize) use error handling; unexpected FS errors stay loud rather than degrading silently |

## Notes (non-blocking)
1. **truncateToBytes over-trims at exact character boundaries** (src/necromancy/reader.ts:341-342). When the byte cut lands exactly at the end of a complete multibyte char, the fixup strips it anyway: probe `"é"+"X"*10` with maxBytes 2 → `""` instead of `"é"`; `"ab😀cd"` with maxBytes 6 → `"ab"` (2 bytes) instead of `"ab😀"` (6 bytes). The hard invariant (≤ maxBytes, no U+FFFD, truncated flagged) still holds — the error is safe-side and loses at most one character — but the docstring "Largest prefix" (:331) is inaccurate. Fix: drop the lead byte only when the stripped continuation-byte count is less than the lead byte's declared sequence length.
2. **Unicode special-casing miss in searchTurns** (reader.ts:253): `"İstanbul"` does not match query `"istanbul"` (Turkish İ lowercases to i+combining dot, shifting lengths). ASCII case-insensitivity — what DW-1.3 specifies and tests — works; full Unicode case folding was not a requirement.
3. **Explicit `limit: undefined` bypasses the configured cap**: `sessionOutline({..., limit: undefined})` spreads `undefined` over the factory's `maxOutlineEntries` (core.ts:365), falling back to reader's 200 default instead of the configured value (same shape for searchOptions). Unreachable through the MCP tool layer as designed; worth a guard if these become directly caller-facing.

## Issues (if FAIL)
None.

**Verdict: PASS**
