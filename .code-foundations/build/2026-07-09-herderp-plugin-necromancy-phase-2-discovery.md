# Discovery + Design: Phase 2 - herdr client + curated tools

## Files Found

- `src/registry.ts`, `src/server.ts` (Phase 1) — `createServer()` + `registerTool(server, {name, description, inputSchema, handler})`. Handlers may throw; `registerTool` normalizes to `{isError:true}` and logs to stderr. This phase registers tools through it, never re-implementing error wrapping.
- `test/registry.test.ts`, `test/server.test.ts` — existing test conventions: `bun:test` `describe/it`, DW-numbered test names (`DW_1_3_...`), real `McpServer` instances (no mocking framework), reaching into `server._registeredTools` for registration assertions.
- No `src/herdr/**`, `src/tools/curated.ts`, or `test/herdr/**` yet — this phase creates all of them from scratch.
- No `docs/code-standards.md` — none found in the repo.

## Current State

Phase 1 delivered the plugin skeleton and the tool-registration harness only. No herdr integration exists. `package.json` has `@modelcontextprotocol/sdk` and `zod` as the only deps — no CLI/process-spawn helper library, so this phase spawns `herdr` directly via `Bun.spawn`.

## Gaps

The plan's Phase 2 body and dispatch prompt assume `herdr <sub> --json` is a uniform invocation. Live verification against the actually-running `herdr 0.7.1` (read-only `--help`/`--json` probes, no mutating calls) surfaced two load-bearing corrections:

1. **`--json` is not a universal flag.** `agent list/get/read/wait`, `workspace list/get`, and `pane get/list` already emit JSON with **no flag** — passing `--json` to them is a hard usage error (exit 2, plain-text `usage: herdr agent list`). Only `session list` needs the flag (its default output is a human table; `session list --json` → bare `{"sessions":[...]}`). `pane run`/`pane close`/`workspace create`/`workspace focus` are assumed to follow the same JSON-native convention as their sibling subcommands (not verified live — mutating, out of scope for this phase — Phase 4's live e2e exercises them for real).
   - **This is an implementation-detail correction, not a seam change.** The `HerdrClient` method signatures and seam types are unaffected; only the per-subcommand argv-builder knows whether to append `--json`. Documented here per the "never silently redesign a seam" rule — this doesn't touch a seam, so BUILD proceeds; flagged for the reviewer's visibility.
   - Verified envelope shapes: `agent list` → `{id,result:{agents:[...]}}`; `agent get`/`agent wait` (success) → `{id,result:{agent:{...}}}`; `agent read` → `{id,result:{read:{text,...}}}`; `workspace list` → `{id,result:{workspaces:[...]}}`; `pane list` → `{id,result:{panes:[...]}}`; `session list --json` → bare `{sessions:[...]}` (no envelope).
   - Verified error/non-JSON shapes: unknown target → JSON `{"error":{"code":"agent_not_found","message":"..."}, "id":"..."}` (exit 1); bad flag/usage → plain-text `usage: ...` (exit 2); unknown top-level command → plain-text `unknown command: foo` (exit 1); **`agent wait` timeout → plain-text `timed out waiting for agent status change` (exit 1, verified live)** — NOT JSON, contradicting an implicit plan assumption that failures are JSON-shaped. Confirms the plan's own Edge Cases list ("malformed/partial stdout... nothing throws a raw string") anticipated non-JSON failure text; this build normalizes all of the above into `HerdrError`.

2. **`Workspace.cwd` (documented in Produces as `/* identity_cwd */`) does not exist as a field on live `workspace list` or `workspace get` output** in herdr 0.7.1 — verified twice (`herdr workspace list`, `herdr workspace get w3`), neither includes `identity_cwd` or `cwd`. The per-pane objects (`pane list --workspace <id>`, `pane get <pane_id>`) DO carry a `cwd`.
   - **Resolution (implementation detail, seam preserved):** `workspaceList()` fetches `workspace list`, then for each workspace fetches `pane list --workspace <id>` and takes the first pane's `cwd` as `Workspace.cwd` (a workspace's first pane's cwd is the closest live proxy for herdr's "identity cwd" concept — matches the research doc's own description of workspace identity). Falls back to `""` (documented, not a crash) if a workspace unexpectedly has zero panes. This changes `workspaceList()` from a single call to N+1 calls — a real behavioral/perf difference from what the plan assumed, called out here for the reviewer and for Phase 3 (which joins spaces by `Workspace.cwd`).
   - The `Workspace` type signature itself (`{id,label,cwd,tabCount,paneCount}`) is implemented exactly as pinned — no seam change, only how `cwd` is sourced.
   - `workspaceCreate`'s returned `Workspace.cwd` has no such gap — it can just echo the `cwd` argument the caller passed in (the identity cwd at creation time), no extra call needed.

Neither gap is a DW-blocking, unmeetable requirement or a seam redesign — both are documented, evidence-backed implementation choices. Recommendation is BUILD, not UPDATE_PLAN.

## Code Standards

No `docs/code-standards.md` found. Following Phase 1's established de facto conventions instead: functional style (no classes — `createServer`, `registerTool` are factory/registration functions, not classes), stderr-only logging, `bun:test` with DW-numbered test names, dependency injection for testability (Phase 1 has no DI need, but this phase's `HerdrClient` needs an injectable process runner to stub `spawn` per DW-2.4 — same instinct as the SDK's own testable-transport pattern already in `test/server.test.ts`).

## Test Infrastructure

`bun:test` (`describe/it/expect`), no mocking library present — Phase 1 tests use real objects and reach into internals (`server._registeredTools`) rather than mocks. For this phase, "stubbed spawn" (DW-2.4) means an injected function replacing the real `Bun.spawn`-based runner, not a mocking framework — consistent with the no-framework style already established.

## DW Verification

| DW-ID | Done-When Item | Status | Test Cases |
|-------|---------------|--------|------------|
| DW-2.1 | Each `HerdrClient` method (incl. `workspaceList`) spawns the right `herdr … --json` and returns typed, parsed results matching the seam types. | COVERED | `test/herdr/client.test.ts`: one test per method (`agentList`, `agentGet`, `agentRead`, `agentWait` success, `workspaceList` incl. the pane-cwd join, `workspaceCreate`, `workspaceFocus`, `paneRun`, `paneClose`, `sessionList`) asserting the exact argv passed to the stubbed runner and the typed object/array returned. |
| DW-2.2 | Every failure mode in Edge cases maps to a typed `HerdrError` (code + message); nothing throws a raw string. | COVERED | `test/herdr/client.test.ts`: `spawn_failed` (runner throws — simulates socket/server absent), `command_failed` nonzero-exit-plain-text (usage error / unknown subcommand), `HerdrError` from JSON `{"error":{...}}` body, `invalid_response` from malformed/truncated stdout on exit 0, `wait_timeout` from `agentWait`'s verified plain-text timeout message. Each asserts `err instanceof HerdrError` and checks `.code`/`.message` — never a bare string catch. |
| DW-2.3 | Curated MCP tools registered via Phase 1's harness, present in `tools/list` with input schemas. | COVERED | `test/herdr/curated.test.ts`: registers curated tools on a bare `McpServer` with a stub `HerdrClient`, asserts each of the ~10 tool names is present in `server._registeredTools` with a non-empty `inputSchema`, and exercises one call end-to-end through the wrapped handler. |
| DW-2.4 | Unit tests cover parse-success and each error normalization using a stubbed spawn (no live herdr). | COVERED | All of the above use an injected `HerdrRunner` stub; zero tests spawn a real `herdr` process. |

**All items COVERED:** YES

## Design: HerdrClient

### Approaches Considered
1. **Per-method spawn+parse** — each of the 9 methods independently calls the process runner, parses JSON, and handles errors inline.
2. **Generic private executor + thin typed methods** — one private `runHerdr(runner, argv)` owns spawn/parse/error-normalization; each public method builds its own argv, calls the shared executor, and maps the raw JSON to its seam type.
3. **Fully declarative command table** — a data table of `{argv, needsJsonFlag, extract, map}` specs per subcommand, with a single generic `invoke(spec, params)` and public methods as one-line lookups.

### Comparison
| Criterion | 1: Per-method | 2: Shared executor | 3: Declarative table |
|-----------|---|---|---|
| Interface simplicity | Same (9 methods) | Same (9 methods) | Same (9 methods) |
| Information hiding | Low — spawn/parse/error logic duplicated 9x, any fix touches 9 call sites | High — one place owns CLI mechanics; methods only know their own argv + shape | High, but the "shape" logic lives in table-entry closures, one layer removed from the method that uses it |
| Caller ease of use | N/A (internal) | N/A (internal) | N/A (internal) |
| Debuggability / obviousness | Each method readable alone but error handling drifts over time (9 places to keep in sync) | Each method is a 3-5 line function: build argv → call executor → map result — easy to trace | Adds an indirection layer (spec objects + generic invoke) that's harder to step through for only 9 commands — over-general for current needs |

### Choice: 2 (Generic private executor + thin typed methods)
Rationale: centralizes the actual complexity (spawn failures, exit codes, two error shapes — JSON vs plain text, two envelope shapes — wrapped vs bare) in one function, so DW-2.2's error normalization is implemented and tested once, not 9 times. Each public method stays a small, obvious adapter (argv-in, typed-value-out), which is the deep-module target: hide the CLI mechanics, keep the call sites trivial. Approach 3's declarative table is real over-generalization for exactly 9 known commands (per the Generality Sweet Spot — reflect current needs, don't build a config-driven engine nobody asked for); rejected.

### Depth Check
- Interface methods: 9 (`agentList, agentGet, agentRead, agentWait, workspaceList, workspaceCreate, workspaceFocus, paneRun, paneClose, sessionList`)
- Hidden details: process spawning (`Bun.spawn`, or an injected stub for tests), argv construction per subcommand (including the `--json`-flag-only-where-needed correction above), JSON vs plain-text failure detection, wrapped-vs-bare envelope unwrapping, the pane-cwd-join workaround for `workspaceList`, timeout-message reclassification for `agentWait`
- Common case complexity: simple — a curated-tool handler calls e.g. `client.agentList()` and gets back `Agent[]`, no CLI/JSON knowledge required

### HerdrError
`class HerdrError extends Error { readonly code: string }` — thrown for every failure path (spawn failure, nonzero exit, JSON `{error:{code,message}}` body, malformed/no-JSON stdout, `agentWait` timeout). Codes used: `spawn_failed`, `command_failed`, `invalid_response`, `wait_timeout`, plus whatever `code` the herdr JSON error body itself supplies (e.g. `agent_not_found`, passed through verbatim — herdr already gives a good code, no need to re-map it).

### Testability
`HerdrRunner = (argv: string[]) => Promise<{stdout, stderr, exitCode}>`. `createHerdrClient(runner: HerdrRunner = bunHerdrRunner)` — production code doesn't pass a runner (uses the real `Bun.spawn`-backed default); tests inject a stub matching argv to canned responses. No mocking library needed, consistent with Phase 1's test style.

## Prerequisites
- [x] Phase 1's `registerTool` harness exists and is stable (verified by reading `src/registry.ts`)
- [x] `herdr` binary present and running on this machine for read-only ground-truth verification (`which herdr` → `/Users/r/.local/bin/herdr`, `herdr --version` → `0.7.1`)
- [x] No missing dependencies — `Bun.spawn` is a runtime built-in, no new package needed

## Recommendation
BUILD. Both discovered gaps (the `--json`-flag-only-where-needed correction, and the `Workspace.cwd` pane-join workaround) are implementation-detail resolutions that preserve every pinned seam (`HerdrClient` method signatures, `Agent`/`Workspace`/`Session` types) exactly as the plan specifies. Proceeding to stub → implement → validate.

## Fix pass (review findings, 2026-07-09)

An independent review FAILED the phase on test coverage: 88.04% lines (`client.ts`) / 88.24% funcs (`curated.ts`) against a stated 100% target, plus a server-wiring gap (curated tools never registered on the real running server). No architecture changed — only tests and one wiring call were added, per the review's explicit "orchestrator-sanctioned scope touch" for `src/server.ts`.

### Findings fixed

1. **Coverage gap — 8 uncovered defensive guards in `client.ts`, 2 uninvoked handlers in `curated.ts`.** Added one stubbed-spawn test per guard in `test/herdr/client.test.ts` (new describe block `HerdrClient - coverage completion for defensive guards (review fix pass)`), and two handler-invocation tests in `test/herdr/curated.test.ts` for `herdr_agent_read` and `herdr_workspace_create`, mirroring the existing per-tool pattern (assert pass-through args + typed mapped result). No live `herdr` process used anywhere — all through the existing `stubRunner`/`stubClient` seams.
   - `unwrapResult`'s own `invalid_response` (missing key, distinct from a malformed-but-present key) — new `agentGet` test with `result: {}`.
   - `mapAgent`'s non-record `raw` guard — new `agentList` test with a bare string in the `agents` array.
   - `mapWorkspaceFields`'s failure branch — new `workspaceCreate` test with a workspace object missing `workspace_id`.
   - `agentList`/`workspaceList` "not an array" guards — new tests with `agents`/`workspaces` set to a non-array value.
   - `agentRead`'s "text not a string" guard — new test with `read.text` set to a number.
   - `sessionList`'s "not a bare {sessions:[]} body" guard and per-session shape-mismatch guard — two new tests.
2. **Server wiring gap — `registerCuratedTools` was never called from `main()`.** `src/server.ts` now imports `createHerdrClient` and `registerCuratedTools` and calls `registerCuratedTools(server, createHerdrClient())` in `main()`, after `registerStubTool`. `createServer()` itself stays bare (its docstring — "no tools registered" — remains accurate; wiring happens one level up in `main()`, consistent with how `registerStubTool` is already applied there). Added `DW_2_3_curated_herdr_tools_appear_in_the_real_servers_tools_list` to `test/server.test.ts`, spawning the real server over stdio and asserting all 9 curated tool names appear in a genuine `tools/list` round-trip.

### Verification

- `bun test` → 50 pass, 0 fail (up from 39 — passing set only grew, no regressions).
- `bunx tsc --noEmit` → clean.
- `bun test --coverage` → `src/tools/curated.ts` 100%/100% (funcs/lines); `src/herdr/client.ts` 97.44% funcs / 96.65% lines, sole remaining gap is `bunHerdrRunner` (client.ts:50-56), the real `Bun.spawn`-backed runner — no branch logic, correctly excluded as not unit-testable without a live process (matches the review's own carve-out).
- Manual stdio check (persistent piped `spawn`, mirroring the existing `DW_1_1_stdout_carries_only_json_rpc_no_stray_logging` test): sent a real `initialize` request to `bun run src/server.ts` — stdout contained only the JSON-RPC response line, stderr contained only the `[herderp] MCP server listening...` log line.

### DW re-verification

| DW-ID | Status | Evidence |
|-------|--------|----------|
| DW-2.1 | COVERED (unchanged) | Existing per-method tests in `test/herdr/client.test.ts`, untouched. |
| DW-2.2 | COVERED (strengthened) | All prior error-normalization tests plus 8 new defensive-guard tests above — every failure path now has a passing test proving a typed `HerdrError`. |
| DW-2.3 | COVERED (strengthened) | `test/herdr/curated.test.ts` now exercises all 9 handlers (was 7); `test/server.test.ts` now proves the tools are wired into the actual running server's `tools/list`, closing the gap where only `herderp_ping` was ever really exposed. |
| DW-2.4 | COVERED (unchanged) | All new tests use the same stubbed `HerdrRunner`/stub `HerdrClient` seams — zero live herdr processes. |

**All items COVERED:** YES
