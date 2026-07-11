<!-- base-commit: 773ae77 -->
<!-- generated: 2026-07-10 -->

# Code Standards

herderp is a Bun + TypeScript (ESM, strict) Claude Code plugin: an stdio MCP server wrapping the `herdr` CLI, plus session necromancy. Conventions below are extracted from the actual source — only what deviates from mainstream defaults.

## Forbidden Patterns

- **No logic in MCP tool handlers.** Handlers are one method call into a core module; all real logic (parsing, scanning, validation, caps) lives in a unit-testable core.
  ```ts
  // DON'T: parse/validate inside the handler
  handler: async ({ space }) => { const dir = slug(space); /* scan... */ }
  // DO: thin delegation (src/tools/necromancy.ts:47)
  handler: async ({ space }) => ({ sessions: await necromancy.listSessions(space) }),
  ```
- **Never crash on malformed input.** Reader/preview code skips unparseable jsonl lines, wrong-type records, and sidechains — it never throws on bad data (`src/necromancy/reader.ts:10-12`).
- **Don't clamp caller limits in core; cap them at the tool boundary.** `core.ts` passes caller `limit`/`maxBytes` through unclamped by design; the zod schema enforces the ceiling via `.max(DEFAULT_MAX_*)` (`src/tools/necromancy.ts:23-28`).

## Error Handling

- Typed errors (`NecromancyError`, `HerdrError`) thrown in core; the `registerTool` harness catches them and turns them into `isError` MCP results — handlers never wrap try/catch themselves (`src/tools/necromancy.ts:3-5`).
- Missing `~/.claude/projects` returns `[]`, not an error — absence is a valid state, not a failure (`src/necromancy/core.ts` `isEnoent`).

## Imports & Dependency Direction

- **ESM with explicit `.js` extensions** on relative imports (NodeNext), even from `.ts` sources: `import { registerTool } from "../registry.js";`
- Direction: `tools/*` → `necromancy/core` → `necromancy/reader`. Core never imports from tools.
- `import type { … }` for type-only imports; keep them separate from value imports.

## Testing Patterns

- **Framework:** `bun:test` (`import { describe, expect, it } from "bun:test"`). Run with `bun test`.
- **Test names encode the done-when ID** they verify: `DW_1_3_registers_a_tool_visible_on_the_server_and_invokes_the_handler`. Non-DW tests get a plain descriptive name.
- Prefer testing core logic directly against temp-dir fixtures over spinning up transports; unit-test the harness against a bare `McpServer` (`test/registry.test.ts:10`).
- Non-null assertions (`result.content[0]!`) and `as unknown as {…}` casts are acceptable in tests to reach internals; keep them out of `src/`.

## Naming

- Files: lowercase, single-word where possible (`core.ts`, `reader.ts`, `preview.ts`, `registry.ts`).
- Exported caps as `SCREAMING_SNAKE` constants (`DEFAULT_MAX_READ_BYTES`), reused as both the runtime default and the zod ceiling.
- MCP tool names: `snake_case`, domain-prefixed (`necromancy_find_spaces`, `necromancy_read`).

## File Organization

- Deep modules: a small interface over substantial hidden complexity. `core.ts` exposes ~6 methods hiding graveyard layout, slug rule, jsonl schema, stat-gating, and caps.
- Every source file opens with a header comment stating its role and the invariants it upholds (see `reader.ts:1-18`) — match this when adding files.
- Pure functions (`reader.ts`) separated from I/O-touching orchestration (`core.ts`).

## Technology Decisions

- Zod for all MCP `inputSchema` shapes; enums need string-literal tuples kept in sync with TS unions via `as const satisfies readonly T[]` (`src/tools/necromancy.ts:21`).
- No test framework beyond `bun:test`; no build step — Bun runs `.ts` directly (`bun run src/server.ts`).
- Deps kept minimal: `@modelcontextprotocol/sdk`, `zod`. Justify any addition.

## Exemplar Files

- `src/necromancy/reader.ts` — pure-function module, header-comment discipline, exported caps, never-crash parsing.
- `src/tools/necromancy.ts` — thin tool registration over core; caps enforced at the boundary.
- `test/registry.test.ts` — DW-named tests, bare-server unit testing, error-path coverage.
