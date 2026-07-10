# Review: Phase 1 - Session-reader core (sample 3)

## Executed Results (Step 0)
- Test suite: `bun test` → 136 pass, 1 skip, 0 fail (137 tests, 10 files). The skip is `test/e2e/revive.test.ts` (env-gated live e2e, pre-existing, out of phase scope).
- Coverage: `bun test --coverage` → `src/necromancy/reader.ts` 100% funcs / 99.46% lines (uncovered-lines column empty — rounding artifact); `src/necromancy/core.ts` 100% / 100%.
- Typecheck: `bunx tsc --noEmit` → exit 0, no errors.
- Lint: none configured (per dispatch).
- Probe script (recorded observed behavior): `scratchpad/sample3/probe.ts` — empty session file → `NecromancyError(session_not_found)`; `readTurns` at multibyte boundaries → cap held, no U+FFFD.

## Requirement Fulfillment

### DW-1.1
PREMISE:  "`parseTurns` maps a real fixture jsonl to ordered role-tagged entries — user text, assistant `thinking`, assistant `text`, each `tool_use` (with tool name), each `tool_result` — with stable 0-based `index` in file order; `isSidechain` and meta/malformed records excluded."
EVIDENCE: src/necromancy/reader.ts:155-181 (parseTurns), 111-140 (turnsFromContent), 77-89 (parseRecord); tests test/necromancy/reader.test.ts:47-170
TRACE:    5-record jsonl (user string, assistant [thinking, text, tool_use Bash], user [tool_result c1]) → line-by-line parseRecord (reader.ts:159-161) → isSidechain===true skipped (162), non-user/assistant type skipped (172-173) → turnsFromContent flattens blocks → indices assigned 0..4 in push order (176-178). Output roles ["user","thinking","text","tool_use","tool_result"], turn 3 carries tool "Bash", turn 4 resolves tool name via toolNameByUseId.
VERDICT:  PASS — tests `DW_1_1_parses_all_role_kinds_in_file_order`, `DW_1_1_excludes_sidechain_and_meta_records`, `DW_1_1_skips_malformed_lines_without_crashing`, `DW_1_1_meta_record_carrying_a_message_object_is_still_excluded` all green in Step 0. (Fixture is hand-built to the documented real schema, not a captured session file — see Notes.)

### DW-1.2
PREMISE:  "`outlineTurns` returns one line per entry (index, role, tool?, clipped text), honors `filter` (e.g. `tool_use` yields only tool calls), and caps/pages via `limit`+`offset` with a correct `total` and `nextOffset`."
EVIDENCE: src/necromancy/reader.ts:196-211; tests reader.test.ts:181-227
TRACE:    10 turns, {limit:4, offset:8} → filter absent → slice(8,12) yields indices [8,9] → total 10, end=10, 10<10 false → nextOffset null. filter:"tool_use" over mixed 4 turns → entries [1,3], total 2. 200-char text → preview clipped to ≤100 chars ending "…" (clip, reader.ts:184-187).
VERDICT:  PASS — `DW_1_2_*` tests (4) green in Step 0.

### DW-1.3
PREMISE:  "`searchTurns` finds case-insensitive lexical matches, returns each with `index`+`role`+`tool?`+bounded snippet, caps at `limit`, and sets `truncated` when more matched."
EVIDENCE: src/necromancy/reader.ts:228-270 (searchTurns), 219-225 (buildSnippet); tests reader.test.ts:233-280
TRACE:    query "flux capacitor" vs "please FIX the Flux Capacitor" → toLowerCase().indexOf ≥ 0 (253) → match {index:0, role:"user", snippet} bounded by SNIPPET_MAX_CHARS=160. 5 matching turns with limit 2 → third match hits `matches.length >= limit` (257) → truncated=true, matches capped at 2. truncated stays false when nothing further matched (loop exhausts without hitting the guard).
VERDICT:  PASS — `DW_1_3_*` tests (5, incl. invalid-regex fallback) green in Step 0.

### DW-1.4
PREMISE:  "`readTurns` returns verbatim entry content for `[from,to]`, enforces both span and byte caps, and sets `truncated` when a cap cut the output. The byte cap is HARD — a returned response must never exceed maxBytes, including when the cap lands mid-multibyte-character, and truncation must not introduce a U+FFFD replacement char."
EVIDENCE: src/necromancy/reader.ts:281-329 (readTurns), 332-344 (truncateToBytes); tests reader.test.ts:286-394
TRACE:    "ab😀cd" (😀 = 4 bytes at offsets 2-5), maxBytes 4 → entryBytes 8 > remaining 4 → truncateToBytes: subarray(0,4) ends with 2 continuation bytes of 😀 → loop strips continuations (341), then the orphaned lead byte 0xF0 (342) → returns "ab" (2 bytes), no U+FFFD; truncated=true. Span: from 0 to 19 with maxSpan 5 → spanCappedTo=4, truncated=true. Byte accumulation: 3×50-byte entries, maxBytes 80 → entries [0, truncated-slice-of-1], cap held. Probe P3 (mid-3-byte "€", cap 2) → "a", no FFFD.
VERDICT:  PASS — `DW_1_4_*` tests (9) green in Step 0; probes P2/P3 confirm the hard cap and no-FFFD invariants at boundaries.

### DW-1.5
PREMISE:  "`sessionSearch`/`sessionOutline`/`sessionRead` reject a non-UUID `sessionId` with a typed `NecromancyError` and construct no filesystem path for it (assert via injected FS that no read is attempted); an absent file → `session_not_found`; an oversized file is stat-gated and never read."
EVIDENCE: src/necromancy/core.ts:330-357 (loadTurns barricade: UUID gate at 331-336 precedes `join` at 338; size gate at 348-350 precedes readSessionText at 352); tests reader.test.ts:466-534
TRACE:    sessionId "x; rm -rf ~" → UUID_RE fails → NecromancyError(invalid_session_id) thrown at core.ts:332 before any `join`/stat/read — the injected-projectsRoot fixture proves this by error-code discrimination: any FS access would have surfaced as session_not_found (no file exists), but the observed code is invalid_session_id. Absent file for valid UUID → stat ENOENT → session_not_found (343-345). Oversized valid-content file with injected maxSessionBytes=100 → size gate throws session_not_found at 348-350 before readSessionText; the error itself proves the read path (which would parse fine) never ran.
VERDICT:  PASS — 9 `DW_1_5_*` tests (3 methods × 3 gates, 5 malicious ids each incl. `"<uuid>\n"` and `""`) green in Step 0. Empty-file gate on this path additionally confirmed by probe P1 (observed: session_not_found).

### DW-1.6
PREMISE:  "caps are enforced from `NecromancyOptions` defaults and overridable; a synthetic huge session never yields a response exceeding the byte cap."
EVIDENCE: src/necromancy/core.ts:80-87 (options), 139-142 (defaults from reader constants), 365/375/387 (applied per method); tests reader.test.ts:536-579
TRACE:    300-turn session, no options → outline capped at DEFAULT_MAX_OUTLINE_ENTRIES=200, nextOffset 200. `maxOutlineEntries: 3` → 3 entries. 500 × ~2KB turns, `maxReadBytes: 4096, maxReadSpan: 1000` → sessionRead from 0 to 499 → summed entry bytes ≤ 4096, truncated=true.
VERDICT:  PASS — `DW_1_6_*` tests (3) green in Step 0.

### DW-1.7
PREMISE:  "`bun test` green; `revive`/`findSpaces`/`listSessions` and their tests unchanged."
EVIDENCE: Step 0 run (136 pass, 0 fail); `git diff HEAD --stat` and `git diff HEAD -- src/necromancy/core.ts test/necromancy/tools.test.ts`
TRACE:    Phase diff touches only: core.ts (adds reader imports, 4 cap options, loadTurns + 3 session* methods, extends the returned object — `findSpaces`/`listSessions`/`revive` bodies byte-identical) and tools.test.ts (stub gains type-satisfying `unexpected(...)` entries for the 3 new methods; no existing test assertion changed). `test/necromancy/core.test.ts` not in the diff at all. Full suite green.
VERDICT:  PASS

**All requirements met:** YES

## Test-DW Coverage
- [x] All DW items have corresponding tests ran in Step 0 (test names carry DW-IDs: `DW_1_1_*` ×9, `DW_1_2_*` ×4, `DW_1_3_*` ×5, `DW_1_4_*` ×9, `DW_1_5_*` ×9, `DW_1_6_*` ×3; DW-1.7 verified by suite run + diff inspection, a spec assertion with no automatable test — recorded observed behavior above).
- [x] Coverage matches the stated level: 100% funcs both files; core.ts 100% lines; reader.ts 99.46% lines with an empty uncovered-lines column (bun rounding on a partial branch — no identifiable uncovered line).
- Empty-file gate on the loadTurns path has no dedicated automated test; covered by recorded probe P1 (observed `session_not_found`) plus the pre-existing `DW_3_3_skips_malformed_empty_and_oversized_jsonl` exercising the same `size === 0` policy.

## Dead Code
None found. No unused imports (tsc clean), no unreachable code, no debug statements, no commented-out blocks in reader.ts or core.ts.

## Correctness Dimensions
| Dimension | Status | Evidence |
|-----------|--------|----------|
| Concurrency | N/A | Pure functions + per-call FS reads; no shared mutable state across calls (toolNameByUseId is per-parseTurns-invocation, reader.ts:156). |
| Error Handling | PASS | Probed: malformed JSON lines → skip (reader.ts:83-84, tested); non-object JSON values → skip (86-88, tested); invalid regex → literal fallback (233-237, tested); ENOENT distinguished from other FS errors, which stay loud (core.ts:127-129, 342-347). No empty catch swallows a bug — every catch either returns a documented fallback or rethrows. |
| Resources | PASS | `readFile`/`stat`/`readdir` promises API — no handles held; no locks/caches/threads. Oversized files stat-gated so no unbounded read (core.ts:348, tested). |
| Boundaries | PASS | Adversarial cases traced/tested: empty turns array (readTurns:284, outline empty), `to < from` → empty (284, tested), from/to clamped to [0, lastIndex] (287-288, tested `from:-5, to:999`), exact byte fit not truncated (tested), budget exhausted exactly then next entry (tested), cap mid-2/3/4-byte char (tested + probes P2/P3), empty string content → no turn (reader.ts:117), empty query → no matches (252). |
| Security | PASS | Non-UUID sessionId rejected before path construction — traced: throw at core.ts:332 precedes `join` at 338; `cwd` cannot traverse because deriveSlug maps `/` and `.` to `-` (core.ts:51-53), so no `..` survives into the joined path; hostile id kept inert in the error message via JSON.stringify + slice(0,80) (334). 5 malicious ids tested per method. |

## Loaded-Skill Criteria

| Skill | Criterion | Status | Evidence |
|-------|-----------|--------|----------|
| cc-defensive-programming | External input validated at entry (barricade) | PASS | Barricade documented and real: UUID gate → stat/size gate → parse, in that order (core.ts:330-357); jsonl content treated as untrusted (skip-never-crash at every parse site, reader.ts:77-89, 143-152). |
| cc-defensive-programming | No empty catch blocks | PASS | All catches (reader.ts:83, 235; core.ts:155, 168, 183, 202, 294, 342) either return a commented, documented fallback or rethrow non-ENOENT errors loud. |
| cc-defensive-programming | Assertions for bugs only / no executable code in assertions | N/A | No assertions used; anticipated runtime errors all use error handling, which is the correct side of the skill's table for external input. |
| cc-defensive-programming | Failures surfaced, not silent | PASS | Typed NecromancyError with codes; permission errors rethrow rather than returning empty (core.ts:157 "stay loud"); truncation always flagged via `truncated`/`nextOffset`. |
| aposd-designing-deep-modules | Deep module / small interface hiding complexity | PASS | Factory exposes 6 methods hiding graveyard layout, slug rule, stat-gating, jsonl schema, UUID validation, byte-safe truncation; callers of session* need zero knowledge of any of it. |
| aposd-designing-deep-modules | Information hiding across boundaries | PASS | reader.ts is pure (no FS knowledge); core.ts owns all FS + validation; caps flow one way via options. No shared internal knowledge leaks to the tool layer. |
| aposd-designing-deep-modules | No silent failure | PASS | Oversized/empty/absent all surface as typed session_not_found rather than an empty result (core.ts:343-355). |

## Notes (non-blocking)
- `truncateToBytes` over-trims when the cap lands exactly at the end of a complete multibyte char: probe P2 — `readTurns([{text:"aé b"}], {maxBytes:3})` returns `"a"` (1 byte) where `"aé"` (3 bytes) fits. The cap is still honored and no FFFD appears, so no DW/edge violation, but the function's doc comment ("Largest prefix … <= maxBytes", reader.ts:331) overstates it — the loop at 341-342 strips a complete trailing char, losing up to one valid char. Fix the comment or check whether `end..buf.byteLength` decodes cleanly before trimming.
- `searchTurns` regex mode compiles a caller-supplied pattern with no complexity/time bound (reader.ts:234) — a pathological pattern can hang the local process (self-inflicted, no privilege boundary crossed; caller is the session owner). Consider a length cap or non-backtracking guard in the tool layer.
- `sessionRead`'s caller-supplied `maxBytes` (and `sessionOutline`'s `limit`) override the configured cap upward with no clamp (core.ts:365, 387) — DW-1.6 says "overridable" so this is per spec, but the Phase 2 tool layer should clamp model-supplied values to a ceiling.
- `outlineTurns` with caller `limit: 0` returns `nextOffset === offset` (reader.ts:209-210), a no-progress page a naive pager could loop on.
- DW-1.1's "real fixture jsonl" is satisfied with hand-built jsonl faithful to the documented schema (incl. summary/ai-title/file-history-snapshot meta records and sidechain), written to a real temp FS — not a captured session file. Substantively equivalent; noting the reading.

## Issues (if FAIL)
None.

**Verdict: PASS**
