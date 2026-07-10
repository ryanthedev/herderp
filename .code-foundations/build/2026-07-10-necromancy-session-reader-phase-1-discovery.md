# Discovery + Design: Phase 1 - Session-reader core

## Files Found
- `src/necromancy/core.ts` — factory `createNecromancy` exporting `findSpaces`/`listSessions`/`revive`, `deriveSlug`, `NecromancyError`, `UUID_RE` (private), `NecromancyOptions`, private `scanSessionFiles`/`withinSizeGate`/`readSessionText`. All present, matches plan's "existing code to reuse."
- `src/necromancy/preview.ts` — pure precedent: `parseSessionPreview(text)`, handles bare-string vs block-array content, malformed lines skipped, never crashes. Style template for `reader.ts`.
- `test/necromancy/core.test.ts`, `test/necromancy/preview.test.ts` — existing test style: `bun:test`, per-test `mkdtemp` fixture dir injected as `projectsRoot`, stub `HerdrClient`, `trackingClient()` helper asserting zero herdr calls for hostile input.
- `test/necromancy/reader.test.ts` — does not exist yet; to be created this phase.
- No real `~/.claude/projects` fixture jsonl was found in-repo; fixtures must be authored inline in the new test file (matches existing test style — `sessionContent`/`jl` helpers build jsonl by hand rather than reading a checked-in file).

## Current State
`core.ts`'s `UUID_RE`, `NecromancyError`, `deriveSlug`, `scanSessionFiles`, `withinSizeGate`, `readSessionText` are module-private (not exported) but are all defined in the same file `sessionOutline`/`sessionSearch`/`sessionRead` will live in, so they're directly reusable without export changes. `revive`'s two-gate barricade pattern (UUID regex check, then stat-based existence check, both before any effectful call) is the template for the new methods' single shared loader.

## Gaps
- `reader.ts` doesn't exist — full new file.
- `NecromancyOptions` has no `maxOutlineEntries`/`maxSearchMatches`/`maxReadBytes`/`maxReadSpan` fields yet.
- The factory return object only has `{findSpaces, listSessions, revive}` — three new methods to add.
- The plan's abbreviated `searchTurns(...): SearchMatch[]` scope bullet conflicts with the **Produces** contract `sessionSearch(...): Promise<{ matches: SearchMatch[]; truncated: boolean }>`. Produces is the locked cross-phase seam per build-agent rules, so `searchTurns` is implemented to return `{ matches, truncated }` (mirroring `outlineTurns`'s `{entries,total,nextOffset}` and `readTurns`'s `{entries,truncated}` shapes) — informal scope prose loses to the explicit Produces contract.
- The plan's `readTurns(turns, {from, to?, maxBytes?})` signature doesn't expose a span-cap parameter, yet DW-1.4/DW-1.6 require an enforced, overridable span cap. Resolution: `readTurns` takes an additional optional `maxSpan` field not enumerated in the phase's shorthand signature — needed to satisfy the explicit DW items and the `sessionRead` produces contract (which itself has no `maxSpan` param, so span cap is server-side only, sourced from `NecromancyOptions.maxReadSpan`, not caller-overridable per call). This is implementation detail filling a gap in the plan's shorthand, not a scope change — flagging it here for visibility rather than silently reinterpreting.

## Code Standards
No `docs/code-standards.md` found in the repo. Conventions inferred from `core.ts`/`preview.ts`: named exports (no default exports), `interface` for object shapes, JSDoc-style block comments explaining *why* above non-obvious functions, barricade validation ordered explicitly with inline comments (`SECURITY GATE 1`/`GATE 2` style), never throw raw strings (always `NecromancyError`), `isEnoent` helper reused for FS error discrimination, `.js` extensions in relative imports (NodeNext/ESM resolution).

## Test Infrastructure
`bun:test` (`describe`/`it`/`expect`/`beforeEach`/`afterEach`). Fixture pattern: `mkdtemp(tmpdir())` per test, `deriveSlug` to compute the space dir, hand-built jsonl via a `jl(value) => JSON.stringify(value)+"\n"` helper. Dirty-path tests assert on `NecromancyError.code` and, for barricade tests, on zero FS/herdr calls via a tracking double. `reader.test.ts` will follow the same shape, with a tracking `readFile`-like check achieved by pointing `projectsRoot` at a fixture dir and asserting no file at all was created/read for the hostile-id case (no herdr client exists in reader.ts's dependency surface, so "no FS reads attempted" is asserted by never writing a session file for that id and confirming a thrown error before any stat/read — verified by the *type* of error, matching the existing pattern for `session_not_found` on `revive`).

## DW Verification

| DW-ID | Done-When Item | Status | Test Cases |
|-------|---------------|--------|------------|
| DW-1.1 | `parseTurns` maps a real fixture jsonl to ordered role-tagged entries (user text, thinking, text, tool_use w/ name, tool_result w/ tool name), stable 0-based index, sidechain/meta/malformed excluded | COVERED | `DW_1_1_parses_all_role_kinds_in_file_order`, `DW_1_1_excludes_sidechain_and_meta_records`, `DW_1_1_skips_malformed_lines_without_crashing`, `DW_1_1_handles_bare_string_and_block_array_content` |
| DW-1.2 | `outlineTurns` one line/entry, honors `filter`, caps/pages via `limit`+`offset` with correct `total`/`nextOffset` | COVERED | `DW_1_2_outline_lists_index_role_tool_and_clipped_preview`, `DW_1_2_filter_narrows_to_tool_use_only`, `DW_1_2_limit_and_offset_page_with_correct_total_and_nextOffset` |
| DW-1.3 | `searchTurns` case-insensitive lexical match, each with index+role+tool?+bounded snippet, caps at `limit`, sets `truncated` | COVERED | `DW_1_3_case_insensitive_match_returns_index_role_tool_and_snippet`, `DW_1_3_limit_caps_results_and_sets_truncated`, `DW_1_3_regex_mode_matches_a_pattern` |
| DW-1.4 | `readTurns` verbatim `[from,to]`, span cap + byte cap independently enforced, `truncated` set on cut | COVERED | `DW_1_4_reads_verbatim_entries_in_range`, `DW_1_4_span_cap_truncates_and_flags`, `DW_1_4_byte_cap_truncates_and_flags`, `DW_1_4_to_less_than_from_is_empty_not_truncated`, `DW_1_4_out_of_range_from_to_clamped` |
| DW-1.5 | non-UUID `sessionId` rejected typed, zero FS reads; absent file -> `session_not_found`; oversized file stat-gated never read | COVERED | `DW_1_5_non_uuid_sessionId_rejected_before_any_path_or_read` (×3 methods, tracking-read double), `DW_1_5_absent_file_is_session_not_found` (×3), `DW_1_5_oversized_file_stat_gated_never_read` (×3) |
| DW-1.6 | caps enforced from `NecromancyOptions` defaults, overridable; huge synthetic session never exceeds byte cap | COVERED | `DW_1_6_default_caps_apply_when_unspecified`, `DW_1_6_caps_overridable_via_options`, `DW_1_6_huge_session_response_never_exceeds_byte_cap` |
| DW-1.7 | `bun test` green; `revive`/`findSpaces`/`listSessions` + tests unchanged | COVERED | full suite run; `core.test.ts` untouched, diffed to confirm byte-identical |

**All items COVERED:** YES

## Design Decisions

### Design: Turn model + query functions

**Approaches considered:**
1. **Discriminated union per role** (`{type:'tool_use', tool, input} | {type:'text', text} | ...`) — maximally precise per-role shapes, but `outlineTurns`/`searchTurns`/`readTurns` all need to treat every role uniformly (index/role/tool?/text), so callers would immediately have to narrow the union back down — adds ceremony with no payoff since no caller needs role-specific fields beyond `tool` and `text`.
2. **Uniform `Turn` shape** (`{index, role, tool?, text}`) where `tool_use` input is pre-serialized into `text` (bounded JSON string) and `tool_result` content is the result text — one shape, all three query functions operate on it directly with zero narrowing. Loses nothing: no caller ever needs the raw parsed `tool_use.input` object, only a boundable string form of it (outline clips it, search matches substrings in it, read returns it verbatim).
3. **Class wrapping the array** (`class TurnIndex { outline(); search(); read(); }`) — rejected: plan's signatures are explicit free functions (`outlineTurns(turns, ...)`), and a class here just adds a constructor step with no encapsulated mutable state to justify it (this module is pure, stateless transforms over an immutable array).

**Comparison:**
| Criterion | 1. Discriminated union | 2. Uniform shape | 3. Class wrapper |
|---|---|---|---|
| Interface simplicity | Lower (union narrowing at every call site) | Higher (one shape) | Same as 2 plus ceremony |
| Information hiding | Leaks per-role field names to every caller | Hides tool_use-input-serialization detail inside `parseTurns` | Same as 2 |
| Caller ease of use | Requires type guards | Direct field access | Direct, but extra construction step |
| Matches plan's given signatures | No (would need remapping) | Yes, as written | Requires wrapping args |

**Choice: 2 (uniform `Turn` shape).** Rationale: matches the plan's free-function signatures exactly, and the one piece of "information" worth hiding — how a `tool_use`'s structured `input` becomes bounded text — stays inside `parseTurns`, never leaking the raw input object to `outlineTurns`/`searchTurns`/`readTurns`.

### Depth Check
- Interface methods: 4 (`parseTurns`, `outlineTurns`, `searchTurns`, `readTurns`) + 3 factory methods (`sessionOutline`/`sessionSearch`/`sessionRead`) — matches plan exactly, no additions.
- Hidden details: jsonl record shape (summary/meta/sidechain filtering), tool_use input serialization/bounding, snippet-extraction algorithm, span/byte cap enforcement order, the UUID-then-stat barricade sequence (shared via one private `loadTurns` helper reused by all three factory methods — avoids duplicating the barricade 3×, matching `revive`'s existing single-path-construction discipline).
- Common case complexity: simple (`sessionOutline({sessionId, cwd})` — no options needed, defaults apply).

### `searchTurns`/`readTurns` return-shape reconciliation
Both pure functions return an object (`{matches,truncated}`, `{entries,truncated}`) rather than a bare array, so the factory methods (`sessionSearch`, `sessionRead`) can `return` the pure function's result directly with zero remapping — one shape, reused at both the pure-function and factory-method boundary. This is also why `outlineTurns` already returns `{entries,total,nextOffset}` in the plan text: consistency across all three query functions, not just search/read.

### Barricade design (cc-defensive-programming)
`loadTurns(sessionId, cwd)` is the single barricade all three factory methods call through — mirrors `revive`'s two gates:
1. **Gate 1 (assertion-strength validation of untrusted input):** `UUID_RE.test(sessionId)` before any `join()`/path construction — a non-UUID id never reaches the filesystem layer at all. Tested via a fixture FS that would visibly fail/record if touched.
2. **Gate 2 (existence + size, still before any content read):** `stat()` the resolved path; ENOENT -> `session_not_found`; `size === 0 || size > maxSessionBytes` -> `session_not_found` (oversized is treated identically to absent — the caller-visible contract is simply "can't retrieve this session," matching the plan's "or empty" latitude).
3. Only after both gates pass does `readSessionText` + `parseTurns` run.

Everything past the barricade (offset/limit/from/to arithmetic inside `outlineTurns`/`searchTurns`/`readTurns`) treats its inputs as already-validated internal data — clamped defensively (never crash on odd offset/from/to) but not re-validated as a security boundary, since those values don't reach the filesystem.

## Prerequisites
- [x] Required files exist to extend (`core.ts`); `reader.ts` and `reader.test.ts` created this phase
- [x] Dependencies available (bun:test, node:fs/promises, node:path — all already used by sibling files)
- [x] No missing prerequisites

## Recommendation
BUILD. Two informal-prose-vs-Produces-contract conflicts identified above (search's return shape, read's span-cap param) are resolved in favor of the explicit Produces contract / explicit DW items, per build-agent scope rules — flagged here rather than silently redesigned, but do not block the phase since they're additive clarifications of an admittedly abbreviated shorthand, not contradictions of the plan's intent.
