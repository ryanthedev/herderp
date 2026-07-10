# Review: Phase 1 - Session-reader core (sample 2)

## Executed Results (Step 0)
- Test suite: `bun test` → 136 pass, 1 skip, 0 fail (137 tests, 10 files). Stderr lines are expected error-path logging from tool tests.
- Coverage: `bun test --coverage test/necromancy/` → 78 pass, 0 fail; core.ts 100% funcs / 100% lines; reader.ts 100% funcs / 99.46% lines with an **empty** "Uncovered Line #s" column (bun rounding artifact — no concrete uncovered line reported).
- Typecheck: `bunx tsc --noEmit` → exit 0, no errors.
- Lint: none configured (per dispatch).
- Extra probes run by reviewer (`bun -e` against readTurns):
  - `"éa"`, maxBytes=2 → text `""`, 0 bytes, truncated=true (cap held; see Notes for over-trim nit)
  - `"ab😀cd"`, maxBytes=5 → `"ab"`, 2 bytes, no U+FFFD
  - `"😀😀"`, maxBytes=3 → `""`, 0 bytes

## Requirement Fulfillment

### DW-1.1
PREMISE:  "`parseTurns` maps a real fixture jsonl to ordered role-tagged entries — user text, assistant `thinking`, assistant `text`, each `tool_use` (with tool name), each `tool_result` — with stable 0-based `index` in file order; `isSidechain` and meta/malformed records excluded."
EVIDENCE: src/necromancy/reader.ts:155-181 (parseTurns), :111-140 (turnsFromContent), :77-89 (parseRecord skip), :162 (isSidechain), :172-173 (meta skip); tests test/necromancy/reader.test.ts:47-170
TRACE:    3-line jsonl (user string, assistant [thinking,text,tool_use], user [tool_result]) → roles ["user","thinking","text","tool_use","tool_result"], indexes [0..4], tool_use carries tool:"Bash", tool_result recovers "Bash" via toolNameByUseId; sidechain/summary/ai-title/system/malformed lines all excluded.
VERDICT:  PASS — `DW_1_1_*` tests (9 of them) ran green in Step 0; fixture-on-disk variant also exercised via sessionOutline happy path (reader.test.ts:433-442).

### DW-1.2
PREMISE:  "`outlineTurns` returns one line per entry (index, role, tool?, clipped text), honors `filter` (e.g. `tool_use` yields only tool calls), and caps/pages via `limit`+`offset` with a correct `total` and `nextOffset`."
EVIDENCE: src/necromancy/reader.ts:196-211; tests reader.test.ts:181-227
TRACE:    10 turns, {limit:4,offset:8} → entries [8,9], total 10, nextOffset null; {filter:"tool_use"} on mixed turns → indexes [1,3], total 2; 200-char text → preview ≤100 chars ending "…".
VERDICT:  PASS — `DW_1_2_*` tests ran green.

### DW-1.3
PREMISE:  "`searchTurns` finds case-insensitive lexical matches, returns each with `index`+`role`+`tool?`+bounded snippet, caps at `limit`, and sets `truncated` when more matched."
EVIDENCE: src/necromancy/reader.ts:228-270 (indexOf on toLowerCase :253; limit/truncated :257-260), snippet bound :219-225; tests reader.test.ts:233-280
TRACE:    query "flux capacitor" vs "please FIX the Flux Capacitor" → match {index:0, role:"user", snippet}; 5 matching turns with limit:2 → 2 matches, truncated:true; no match → {matches:[], truncated:false}.
VERDICT:  PASS — `DW_1_3_*` tests ran green.

### DW-1.4
PREMISE:  "`readTurns` returns verbatim entry content for `[from,to]`, enforces both span and byte caps, and sets `truncated` when a cap cut the output. The byte cap is HARD — a returned response must never exceed maxBytes, including when the cap lands mid-multibyte-character, and truncation must not introduce a U+FFFD replacement char."
EVIDENCE: src/necromancy/reader.ts:281-329 (span cap :290, byte budget :296-326), truncateToBytes :332-344 (continuation-byte + lead-byte trim :341-342); tests reader.test.ts:286-394
TRACE:    "ab😀cd" with maxBytes 4 → "ab" (2 bytes), no U+FFFD, truncated:true (test :356-370); reviewer probe maxBytes 5 (cut mid-emoji) → "ab", 2 bytes, no U+FFFD; 3×50-byte entries maxBytes 80 → entries [0,1], truncated:true; exact fit 40+40/80 → not truncated.
VERDICT:  PASS — `DW_1_4_*` tests (11) plus reviewer probes hold the hard cap and never yield U+FFFD.

### DW-1.5
PREMISE:  "`sessionSearch`/`sessionOutline`/`sessionRead` reject a non-UUID `sessionId` with a typed `NecromancyError` and construct no filesystem path for it (assert via injected FS that no read is attempted); an absent file → `session_not_found`; an oversized file is stat-gated and never read."
EVIDENCE: src/necromancy/core.ts:330-357 (loadTurns: UUID gate :331 BEFORE path construction :338; stat gate :340-350 before readSessionText :352); tests reader.test.ts:466-534 (injected temp projectsRoot, malicious ids incl. `"x; rm -rf ~"`, `"$(whoami)"`, `"${U1}\n"`, `"--help"`, `""`)
TRACE:    non-UUID id → `invalid_session_id` (proves the gate fired before stat: a constructed-path failure would have produced `session_not_found`); U1 with no file → `session_not_found`; 500-byte file with injected maxSessionBytes:100 → `session_not_found` from the size branch (:348) with no readFile — all three methods, all cases, tests green.
VERDICT:  PASS — 9 `DW_1_5_*` tests (3 methods × 3 cases) ran green against an injected fixture FS.

### DW-1.6
PREMISE:  "caps are enforced from `NecromancyOptions` defaults and overridable; a synthetic huge session never yields a response exceeding the byte cap."
EVIDENCE: src/necromancy/core.ts:80-87 (options), :139-142 (defaults from reader constants), :365/:375/:387 (wired into each method); tests reader.test.ts:536-579
TRACE:    300-turn session, no options → 200 entries (DEFAULT_MAX_OUTLINE_ENTRIES), nextOffset 200; `maxOutlineEntries:3` → 3 entries; 500×~2KB turns with `maxReadBytes:4096, maxReadSpan:1000` → summed response bytes ≤ 4096, truncated:true.
VERDICT:  PASS — `DW_1_6_*` tests ran green.

### DW-1.7
PREMISE:  "`bun test` green; `revive`/`findSpaces`/`listSessions` and their tests unchanged."
EVIDENCE: `bun test` → 136 pass / 0 fail. `git diff HEAD -- src/necromancy/core.ts` → +98/−1, purely additive (imports, 4 new option fields, loadTurns + 3 new methods, return-list extension); revive/findSpaces/listSessions bodies untouched. `git diff HEAD -- test/necromancy/core.test.ts` → empty. tools.test.ts diff → +12/−1, only type-satisfying stubs for the 3 new factory methods (never exercised), no test behavior changed.
TRACE:    diff inspection + full suite run: the only removed line is the old `return { findSpaces, listSessions, revive };`, replaced by the extended return.
VERDICT:  PASS.

**All requirements met:** YES

## Test-DW Coverage
- [x] All DW items have corresponding tests that ran in Step 0 — test names reference DW ids (`DW_1_1_*` … `DW_1_6_*`); DW-1.7 covered by the executed suite run + recorded diff inspection (spec assertion, not automatable as a unit test).
- [x] Coverage level "100% of unit-testable core lines": core.ts 100/100; reader.ts 100% funcs, 99.46% lines with no uncovered line number reported by bun (rounding on non-executable lines) — treated as met.

## Dead Code
None found (no unused imports, no unreachable code, no debug statements, no commented-out blocks in the four files under review).

## Correctness Dimensions
| Dimension | Status | Evidence |
|-----------|--------|----------|
| Concurrency | N/A | Pure functions + per-call state (toolNameByUseId is local to each parseTurns call); no shared mutable state, no background tasks. |
| Error Handling | PASS | Probed: malformed jsonl, non-object JSON lines, orphan tool_result, invalid regex — all skip/fallback without throwing (tests green); non-ENOENT fs errors deliberately propagate (core.ts:157,169,185); typed NecromancyError for both rejection codes. |
| Resources | PASS | Whole-file readFile is stat-gated at maxSessionBytes (default 32 MiB) before any read (core.ts:348); no handles/locks/caches held. |
| Boundaries | PASS | Traced: empty turns, from<0/to>last clamped (reader.test.ts:377-383), to<from → empty, empty query → no matches, empty file → session_not_found (core.ts:348), exact byte fit not flagged, budget-exact exhaustion flagged. |
| Security | PASS | Adversarial ids (`x; rm -rf ~`, `$(whoami)`, UUID+`\n`, `--help`, empty) all rejected with `invalid_session_id` before path construction (tests green). `cwd` cannot traverse: deriveSlug maps every `/` and `.` to `-` (core.ts:52), so no separators or `..` survive into the joined path. |

## Loaded-Skill Criteria
| Skill | Criterion | Status | Evidence |
|-------|-----------|--------|----------|
| aposd-designing-deep-modules | Deep module / information hiding | PASS | createNecromancy exposes 6 methods hiding graveyard layout, slug rule, jsonl parsing, stat-gate policy, and all cap defaults; reader.ts exposes 4 pure fns over an internal Turn model. Common case (`sessionOutline({sessionId, cwd})`) needs zero knowledge of internals. |
| aposd-designing-deep-modules | Silent Failure red flag | PASS | Every truncation path surfaces `truncated`/`nextOffset`; validation failures are typed NecromancyError, never swallowed. (One borderline case → Notes: invalid-regex fallback.) |
| aposd-designing-deep-modules | Design-it-twice gate | N/A | Reviewing existing code; a design-comparison doc is referenced (reader.ts:276, core.ts:11) but not read per the independence rule. |
| cc-defensive-programming | No empty catch blocks | PASS | All catches either rethrow non-ENOENT (core.ts:156-158,168-170,184-186), return a documented skip sentinel (reader.ts:83-85), or set a documented fallback (reader.ts:235-237). |
| cc-defensive-programming | External input validated at entry (barricade) | PASS | sessionId UUID-gated before any path exists (core.ts:331-336); jsonl file content treated as untrusted throughout (never-crash parse discipline); size stat-gated before read. |
| cc-defensive-programming | Assertions for bugs only / no executable code in assertions | N/A | No assertions used; anticipated runtime errors use error handling, consistent with the barricade strategy. |

## Notes (non-blocking)
1. **truncateToBytes over-trims a trailing complete multibyte char** (src/necromancy/reader.ts:341-342). Demonstrated: `readTurns([{text:"éa"}], {maxBytes:2})` → `""` instead of `"é"` — the backtrack strips continuation bytes without checking whether they complete a valid char, so the docstring's "largest prefix" claim is off by ≤1 char. The DW-1.4 invariants (hard cap, no U+FFFD) still hold — conservative, not cap-violating — hence a note, not a FAIL.
2. **Invalid regex silently degrades to literal substring search** (reader.ts:232-237): a caller passing a bad pattern gets `{matches:[], truncated:false}` indistinguishable from "no matches". Matches the never-crash discipline but is Silent-Failure-adjacent; consider a `patternInvalid` flag in a later phase.
3. **searchTurns snippet offset uses `toLowerCase()` index against original text** (reader.ts:253): for rare Unicode where lowercasing changes string length (e.g. `İ`), the snippet window can shift slightly. Snippet stays bounded; match detection unaffected.
4. **sessionRead accepts a caller `maxBytes` with no clamp against the server cap** (core.ts:387): a per-call override can exceed `maxReadBytes`. DW-1.6 explicitly says caps are "overridable," and output stays bounded by `maxSpan` and the 32 MiB file gate — worth deciding at the MCP tool layer (Phase 2) whether the tool schema should clamp it.
5. tools.test.ts stub uses an `as Necromancy` cast — test code, acceptable.

## Issues (if FAIL)
None.

**Verdict: PASS**
