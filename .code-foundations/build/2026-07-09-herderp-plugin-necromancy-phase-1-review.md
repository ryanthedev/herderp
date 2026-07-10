# Review: Phase 1 - Scaffold + MCP server boot

## Executed Results (Step 0)
- Test suite: `bun test` → **10 pass, 0 fail, 26 expect() calls** across 3 files (705ms). (The one visible `error: kaboom` stack trace in the output is the expected `console.error` from the "wraps a thrown handler error" test in `test/registry.test.ts` — assertions on it pass.)
- Typecheck: `bunx tsc --noEmit` → exit 0, no output (clean).
- Lint: no lint script/config declared in `package.json`; none run (no lint tooling present in this repo).
- Manual boot check: `bun run start` (== `package.json`'s `start` script) → exit 0, stdout empty, stderr carries exactly `[herderp] MCP server listening on stdio (v0.1.0)`.
- External verification: fetched `code.claude.com/docs/en/plugins-reference.md` live to check the manifest schema (see DW-1.2/edge-case below) rather than trusting the test file's own comment about what the docs say.

## Requirement Fulfillment

### DW-1.1
PREMISE:  server entry starts over stdio and answers `initialize` + `tools/list` without error (stdout carries only JSON-RPC).
EVIDENCE: src/server.ts:30-37 (`main()` builds server, connects `StdioServerTransport`); test/server.test.ts:26-38, 59-91
TRACE:    `bun run src/server.ts` spawned as child → SDK `Client.connect()` performs `initialize` handshake → `client.getServerVersion()?.name === "herderp"` (test passed) → `client.listTools()` returns an array (test passed) → separately, raw stdin `initialize` JSON-RPC sent to a raw-spawned child, raw stdout captured and every non-empty line parsed as JSON via `JSON.parse` without throwing (test passed).
VERDICT:  PASS

### DW-1.2
PREMISE:  `.claude-plugin/plugin.json` declares the plugin and registers the stdio MCP server; plugin loads with no manifest error.
EVIDENCE: .claude-plugin/plugin.json:1-9; .mcp.json:1-8; test/plugin-manifest.test.ts:18-50
TRACE:    manifest read → `name: "herderp"` is a non-empty kebab-case string (test passed) → manifest has no inline `mcpServers` (test passed) → `.mcp.json` at plugin root declares `mcpServers.herderp` with `command`/`args` (test passed) → args reference `${CLAUDE_PLUGIN_ROOT}` and not a hardcoded absolute path (test passed).
VERDICT:  PASS

### DW-1.3
PREMISE:  `registerTool()` registers a `{name, description, inputSchema, handler}` def; a stub tool appears in `tools/list` and returns on call.
EVIDENCE: src/registry.ts:32-37 (`ToolDefinition` shape), :54-79 (`registerTool`); src/server.ts:21-28 (stub registration); test/registry.test.ts:15-42; test/server.test.ts:40-57
TRACE:    `registerTool(server, {name:"echo", description, inputSchema:{value:z.string()}, handler})` → `server._registeredTools.echo` exists → invoking its wrapped handler with `{value:"hi"}` returns `{content:[{type:"text",text:'{"value":"hi"}'}]}`, `isError` falsy (test passed). End-to-end: real stdio client's `listTools()` finds `herderp_ping` with the expected description, `callTool({name:"herderp_ping"})` returns `isError` falsy and a JSON body with `ok:true` and a string `timestamp` (test passed).
VERDICT:  PASS

### DW-1.4
PREMISE:  `bun test` runs green (zero or a smoke test); `bun run` boots the server.
EVIDENCE: package.json:7-10 (`scripts.start`, `scripts.test`)
TRACE:    `bun test` → 10 pass / 0 fail (Step 0). `bun run start` → process starts, logs the "listening on stdio" line to stderr, stdout stays empty, exits 0 when stdin closes (Step 0 manual check).
VERDICT:  PASS

### DW-1.5
PREMISE:  leftover `.necrotest/` research artifact removed; repo tree clean.
EVIDENCE: `.gitignore:5` still lists `.necrotest/` (defensive, prevents re-tracking) but no such directory exists anywhere in the tree.
TRACE:    `find . -iname "*necrotest*"` (explicit `/usr/bin/find`, excluding `node_modules`) → zero matches. `git status --porcelain=2` → no `.necrotest` entry, untracked/modified files are only the expected new scaffold (`src/`, `test/`, `.mcp.json`, `.claude-plugin/`, config files) plus one already-tracked plan-doc diff.
VERDICT:  PASS

**All requirements met:** YES

## Test-DW Coverage
- [x] DW-1.1 — `test_DW_1_1_boots_over_stdio_and_answers_initialize_and_tools_list`, `test_DW_1_1_stdout_carries_only_json_rpc_no_stray_logging` (both ran, both pass)
- [x] DW-1.2 — `test_DW_1_2_declares_the_plugin_with_a_required_name_field`, `test_DW_1_2_registers_the_herderp_stdio_server_at_the_plugin_root` (+2 supporting tests, all pass)
- [x] DW-1.3 — `test_DW_1_3_registers_a_tool_visible_on_the_server_and_invokes_the_handler` (registry.test.ts) and `test_DW_1_3_stub_tool_appears_in_tools_list_and_returns_on_call` (server.test.ts), both pass
- [x] DW-1.4 — covered by the full green suite (Step 0) plus an observed `bun run start` boot (recorded above; not itself an automated test, but DW-1.4's "bun run boots the server" clause is a one-shot process-boot check with no existing automated assertion — recorded observed behavior per Step 2)
- [x] DW-1.5 — no automated test exists for "no leftover artifact"; recorded observed behavior via `find`/`git status` (Step 2 fallback — this is a repo-hygiene check, not something a unit test would sensibly assert)

Coverage matches the stated 100% level: every DW item has either a passing automated test or, where no automated test is sensible (DW-1.4's manual boot clause, DW-1.5's artifact-absence), recorded observed behavior from a command actually run in Step 0.

## Dead Code
None found. `src/server.ts` and `src/registry.ts` have no unreachable code, no unused imports, no debug `console.log`, no commented-out blocks. The one `console.error` call sites are intentional (see Edge Cases below), not leftover debug statements.

## Correctness Dimensions
| Dimension | Status | Evidence |
|-----------|--------|----------|
| Concurrency | N/A | Phase 1 has no shared mutable state, no async coordination beyond a single `server.connect()` call; no concurrency surface exists yet. |
| Error Handling | PASS | src/registry.ts:64-76: `handler(args)` is awaited inside try/catch; a thrown error is caught, logged to stderr (never stdout), and turned into `{content:[...], isError:true}` rather than rethrown or crashing the process — verified by the "wraps a thrown handler error" test (registry.test.ts:44-67), which asserts `isError === true` and the message is preserved. |
| Resources | N/A | No file handles, connections (beyond the single stdio transport, closed by the SDK/tests), locks, or caches in Phase 1 scope. |
| Boundaries | PASS | Traced the empty-`inputSchema` case (`herderp_ping`, `{}`): `ToolArgs<{}>` resolves to `{}`, `handler({})` runs fine, `toText` handles both string and object returns (registry.ts:81-83) — both branches exercised by tests (registry.test.ts:69-88 for the string branch, :15-42 for the object branch). No indexing or numeric edge cases exist in this phase's code. |
| Security | N/A | No untrusted external input is parsed yet (Phase 1's only handler is a static stub with no arguments); Zod-based schema validation is delegated to the SDK for future phases. |

## Loaded-Skill Criteria
Skill loaded: `code-foundations:aposd-designing-deep-modules`. This skill is normally invoked pre-implementation to compare design alternatives; applied here retroactively as an assessment of `src/registry.ts`'s `registerTool` interface against its depth/information-hiding checklist, since no new design decision was being made in this review pass.

| Skill | Criterion | Status | Evidence |
|-------|-----------|--------|----------|
| aposd-designing-deep-modules | Interface depth (few methods, much hidden functionality) | PASS | One exported function (`registerTool`) plus type aliases hides: MCP `CallToolResult` content-array wrapping, error-to-`isError` normalization, and stderr-only failure logging (registry.ts:39-53, 64-78). Caller supplies only `{name, description, inputSchema, handler}`. |
| aposd-designing-deep-modules | Silent-failure red flag (module must surface failure states, not swallow them) | PASS | A thrown handler error is not swallowed: it is logged to stderr AND returned to the MCP caller as `{isError:true, content:[{text: message}]}` (registry.ts:68-75) — traced and confirmed by the "wraps a thrown handler error" test. |
| aposd-designing-deep-modules | Information leakage / single-use method red flags | PASS | `registerTool` is written for reuse across the ~12 tools planned for Phases 2-3 (per registry.ts:3 header comment) and is exercised with three distinct shapes (object-returning, string-returning, throwing) in tests — not a single-caller shim. No duplicated MCP-shape knowledge appears in `server.ts`; it only supplies `{name, description, inputSchema, handler}` data, never touches `content`/`isError`. |

## Notes (non-blocking)
- The plugin manifest and `.mcp.json` were independently checked against the live `code.claude.com/docs/en/plugins-reference.md` (fetched fresh during this review, not taken on the test file's word): `name` is confirmed as the only required `plugin.json` field, and `.mcp.json` at the plugin root is a documented default location for MCP server config — both files are schema-valid under the real spec, not just the repo's own test assertions about that spec.
- `test/plugin-manifest.test.ts` up front is honest that it validates *shape*, not a live Claude Code host load; this review's independent doc-fetch closes that gap for the manifest-shape claim, but a live `claude --debug` load was still not performed (no running Claude Code host available in this environment) — flagged for completeness, not a blocker since the DW item only requires manifest schema validity plus the shape-level test the repo already has.
- No lint tooling (eslint/biome/etc.) is configured in this repo; nothing to run or report there.

**Verdict: PASS**
