# Discovery + Design: Phase 2 - MCP tools + skill guidance

## Files Found
- `src/tools/necromancy.ts` — existing thin registrations for `necromancy_find_spaces`/`necromancy_list_sessions`/`necromancy_revive`, all delegating to a `Necromancy` core instance. `registerTool` (src/registry.ts) already turns thrown errors into `isError` results.
- `src/server.ts` — calls `registerNecromancyTools(server, createNecromancy({ client }))` once; the necromancy core factory is already fully constructed there.
- `skills/necromancy/SKILL.md` — currently documents only the find→list→revive flow. No read-a-session section yet.
- `test/necromancy/tools.test.ts` — existing tests stub `sessionOutline`/`sessionSearch`/`sessionRead` as "unexpected call" placeholders (added defensively when Phase 1 extended the `Necromancy` type), not yet exercised.
- `src/necromancy/core.ts` (Phase 1, given) — `sessionOutline`/`sessionSearch`/`sessionRead` exist, validated, capped by configured defaults, but do NOT clamp a caller-supplied `limit`/`offset`/`maxBytes` down to those defaults (confirmed by reading `sessionOutline`/`sessionSearch`/`sessionRead` bodies: `{ limit: maxOutlineEntries, ...outlineOptions }` — spread after the default means caller wins).
- `src/necromancy/reader.ts` (Phase 1, given) — exports `DEFAULT_MAX_OUTLINE_ENTRIES` (200), `DEFAULT_MAX_SEARCH_MATCHES` (50), `DEFAULT_MAX_READ_BYTES` (65536), `TurnRole`. These are usable as the tool-layer zod ceilings without modifying reader.ts.

## Current State
Three necromancy tools registered and tested. Necromancy core factory (Phase 1) exposes the three new read methods, fully tested in isolation (44 tests, 100% line coverage per Phase 1 execution log). No MCP tool exposes them yet; no skill guidance for reading exists.

## Gaps
- No `necromancy_outline`/`necromancy_search`/`necromancy_read` tool registrations.
- No zod ceiling on `limit`/`offset`/`maxBytes` at the tool boundary — per the Phase 1 review carry-over, this MUST be added here since core.ts passes caller values through unclamped.
- SKILL.md has no read-vs-revive guidance.
- No integration test driving outline→search→read through the real registry against a fixture session file.

## Code Standards
No `docs/code-standards.md` found in the repo. Conventions inferred from existing code (consistent across core.ts/reader.ts/tools/necromancy.ts): heavy header comments explaining the "why", named constants over magic numbers, thin tool handlers that are one-line delegations, typed errors surfaced via `registerTool`, `bun:test` describe/it blocks named after DW-IDs, stub clients/cores with an "unexpected call" pattern for methods not under test.

## Test Infrastructure
`bun:test` (describe/it/expect), Bun's built-in runner. Fixture pattern for FS-touching tests: `mkdtemp`/`writeFile`/`rm` in `beforeEach`/`afterEach` (see core.test.ts), used here for the integration test's fixture session file. `tools.test.ts` pattern: stub `Necromancy` object, register on a bare `McpServer`, reach into `server._registeredTools` to get `{description, inputSchema, handler}`.

## DW Verification

| DW-ID | Done-When Item | Status | Test Cases |
|-------|---------------|--------|------------|
| DW-2.1 | Three tools registered, appear in tools/list with input schemas; thin handlers; bad/absent session → isError, not a crash | COVERED | `DW_2_1_three_reader_tools_present_with_input_schemas`, `DW_2_1_necromancy_outline_search_read_pass_args_through_to_the_core` (thinness), `DW_2_1_a_thrown_NecromancyError_from_any_reader_tool_surfaces_as_isError` |
| DW-2.2 | Integration test drives outline→search→read against a fixture session via the real registry, role-tagged/index-linked/capped end to end | COVERED | `DW_2_2_outline_search_read_integration_over_a_fixture_session_via_the_real_registry` |
| DW-2.3 | SKILL.md gains read-a-session section; frontmatter triggers cover reading; validate_skill zero errors | COVERED | manual `validate_skill` MCP call after edit (T2.3); frontmatter trigger wording reviewed by inspection (T2.4 is manual per plan) |
| DW-2.4 | `bun test` green; existing revive tool + skill flow unchanged | COVERED | full `bun test` run; no edits to revive/find_spaces/list_sessions tools or their tests |

**All items COVERED:** YES

## Design Decisions

**Zod ceiling placement.** The Phase 1 review carry-over requires the tool layer to cap caller-supplied `limit`/`maxBytes`/`offset`. Options considered:
1. Clamp inside each handler body (`Math.min(args.limit, CEILING)`) — rejected: violates DW-2.1's "handler is a thin call into the Phase 1 method (no logic)".
2. Zod `.max()` on the input schema itself — chosen. A call requesting an over-ceiling value is rejected by the MCP SDK's schema validation before the handler even runs, which is a stronger guarantee than a silent clamp (the caller gets a validation error, not a quietly-smaller result) and keeps the handler a pure one-line delegation.

Ceilings taken directly from reader.ts's existing exported defaults (`DEFAULT_MAX_OUTLINE_ENTRIES`=200, `DEFAULT_MAX_SEARCH_MATCHES`=50, `DEFAULT_MAX_READ_BYTES`=65536) rather than inventing new numbers — these are already the values core.ts uses as its own defaults, so the tool-layer ceiling matches server-side intent exactly. Imported directly from `../necromancy/reader.js` (read-only import, not a modification — reader.ts stays in Phase 1's untouched file scope).

**`filter` param.** `necromancy_outline`'s `filter` takes the same `TurnRole` union reader.ts defines (`"user"|"thinking"|"text"|"tool_use"|"tool_result"`), expressed as a zod `z.enum([...])` literal list (zod enums can't consume a TS type directly, so the five string literals are spelled out and kept in sync by a compile-time check: the array feeds into `TurnRole[]`-typed satisfies).

**Description content.** Per plan: each tool's description states its cap and the pointer/index contract (i.e., that `index` values from outline/search are the addressable unit `read` consumes) so the model chains them correctly without guessing.

## Prerequisites
- [x] Required files exist (tools/necromancy.ts, server.ts, SKILL.md, tools.test.ts all present)
- [x] Phase 1 methods available and stable (given, not re-reviewed)
- [x] Test fixture pattern already established in the codebase (core.test.ts, reader.test.ts)

## Recommendation
BUILD. Register the three tools with zod-ceiling'd schemas, wire into server.ts (already calls registerNecromancyTools — no change needed there since it's the same call site), extend SKILL.md, add presence + integration + dirty tests.
