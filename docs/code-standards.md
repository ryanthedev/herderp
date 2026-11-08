<!-- base-commit: 980c5ed -->
<!-- generated: 2026-11-08 -->

# Code Standards

herderp is a Bun + TypeScript (ESM, strict) Claude Code plugin: an stdio MCP server wrapping the `herdr` CLI, session necromancy, and an agent watcher run under Claude Code's Monitor tool. Only conventions that deviate from mainstream defaults are listed.

## Forbidden Patterns

- **No logic in MCP tool handlers.** A handler validates its action's fields, makes one call into a core module, and wraps the result. Parsing, scanning and caps live in unit-testable cores.
  ```ts
  // DO (src/tools/necromancy.ts): thin delegation
  handler: async ({ space }) => ({ sessions: await necromancy.listSessions(space) }),
  ```
- **No direct `Bun.spawn` outside the one runner.** Every process boundary is an injected function (`HerdrRunner`, `SpawnFn`) with a real default, so tests stub it instead of spawning. `bunHerdrRunner` in `src/herdr/client.ts` is the only place that spawns `herdr`.
- **Never crash on malformed input.** Readers skip unparseable jsonl lines, wrong-type records and sidechains (`src/necromancy/reader.ts`). Socket readers skip non-object lines (`src/herdr/events.ts`).
- **Don't clamp caller limits in core; cap them at the tool boundary** with zod `.max(DEFAULT_MAX_*)` (`src/tools/necromancy.ts`).
- **Don't assert unverified response shapes.** When a CLI's success envelope wasn't seen live, report success by exit code and say so in a comment (`src/herdr/client.ts`, "Mutating agent control" block).
- **Timers and I/O stay out of state machines.** `src/watch/watcher.ts` takes `now` on every input; `src/watch/run.ts` owns sockets, polls and clocks.

## Error Handling

- **Typed errors with a string `code`** (`HerdrError`, `NecromancyError`). Every failure in a client normalizes to its typed error; no raw string or stdout blob escapes.
- **`registerTool` renders `[code] message`** and turns any throw into an `isError` result (`src/registry.ts` `errorText`). Handlers never try/catch.
- **Missing required fields name the tool, action and field:**
  ```ts
  need(args.target, "target", tool, "get"); // -> herdr_agent{action:"get"} requires "target"
  ```
- **Degrade, don't fail, on an unreachable dependency** when the rest of the answer stands alone. Catch only the dependency's typed error and rethrow everything else:
  ```ts
  } catch (error) {
    if (!(error instanceof HerdrError)) throw error; // non-herdr faults stay loud
    degraded = true;
  }
  ```
- Absence is a state, not an error: a missing `~/.claude/projects` returns `[]`.

## Imports & Dependency Direction

- **ESM with explicit `.js` extensions** on relative imports, even from `.ts`: `import { registerTool } from "../registry.js";`
- **`import type { … }`** for type-only imports, separate from value imports.
- **Direction:** `server` -> `tools/*` -> domain cores (`herdr/`, `necromancy/`, `watch/`). `registry.ts` is shared infrastructure and imports no domain (it reads error `code` structurally). Cores never import from `tools/`.

## Testing Patterns

- **`bun:test`**, run with `bun test`. Tests mirror `src/` under `test/`.
- **Stub runners, not mocking libraries.** A stub returns canned results in call order and records every argv; tests assert the exact argv sent and the typed value or error produced:
  ```ts
  function stubRunner(results: HerdrRunResult[]): { runner: HerdrRunner; calls: string[][] } // test/herdr/client.test.ts
  ```
- **Canned payloads are copied from live output** (`RAW_AGENT` in `test/herdr/client.test.ts`) and named `RAW_*`.
- **Done-when tests carry their ID in the name:** `DW_1_3_registers_a_tool_visible_on_the_server_and_invokes_the_handler`.
- **Fake clocks for anything time-based** (`test/watch/watcher.test.ts`); temp-dir fixtures for disk readers.
- Non-null assertions and `as unknown as {…}` casts are fine in tests; keep them out of `src/`.

## Naming

- **Files:** lowercase, one word where possible (`client.ts`, `hosts.ts`, `watcher.ts`).
- **Factories:** `createXxx(deps)` returning an interface (`createHerdrClient(runner)`, `createHostRegistry(options)`).
- **Caps:** `SCREAMING_SNAKE` constants reused as runtime default and zod ceiling (`DEFAULT_MAX_READ_BYTES`).
- **MCP tools:** `snake_case`, domain-prefixed, one tool per resource with an `action` enum (`herdr_agent{action:"read"}`).
- **Fields mirror the consumer, not the source:** `sessionId`, not `id`, so results feed straight into the next tool's params.

## File Organization

- **Deep modules:** one interface over the hidden mess. `HerdrClient` hides argv grammar, JSON envelopes and error normalization behind typed methods.
- **Every source file opens with a header comment** stating its role and invariants (`src/watch/run.ts:1-21`). Match it when adding files.
- **Pure / I/O split:** `reader.ts` vs `core.ts`; `watcher.ts` vs `run.ts`.
- **Every tool result carries a `hint`** naming the natural next call (`ok(hint, data)` in `src/tools/curated.ts`).
- Design and phase docs live in `.code-foundations/{research,plans,build}/`.

## Technology Decisions

- **Zod** for every `inputSchema`; enums kept in sync with TS unions via `as const satisfies readonly T[]` (`src/tools/curated.ts`).
- **No build step:** Bun runs `.ts` directly (`bun run src/server.ts`). Deps: `@modelcontextprotocol/sdk`, `zod`. Justify any addition.
- **Remote hosts are one `ssh` exec of the remote's own `herdr`**, BatchMode, exit status carried in-band (`src/herdr/hosts.ts`), because Tailscale SSH reports exit 0 regardless.
- **Watch is a CLI, not a tool loop:** the MCP action returns a command for Monitor, since MCP can't push into a conversation (`src/watch/command.ts`).

## Exemplar Files

- `src/herdr/client.ts`: injected runner, typed methods, error normalization, honest comments on unverified shapes.
- `src/watch/watcher.ts` + `src/watch/run.ts`: pure state machine beside its I/O shell.
- `src/tools/curated.ts`: one-tool-per-resource with `action`, `need()`, `ok(hint)`.
- `test/herdr/client.test.ts`: stub runner, argv assertions, `RAW_*` payloads.
