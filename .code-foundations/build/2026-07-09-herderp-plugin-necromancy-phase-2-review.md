# Review: Phase 2 - herdr client + curated tools

## Executed Results (Step 0)
- Test suite: `bun test` → 50 pass, 0 fail, 152 expect() calls, across 5 files (registry.test.ts, herdr/client.test.ts, herdr/curated.test.ts, server.test.ts, and one other). Two expected `console.error` traces printed (tests deliberately exercising thrown-error paths - not failures).
- Coverage: `bun test --coverage` → All files 99.36% funcs / 99.16% lines. Only uncovered lines: `src/herdr/client.ts:50-56` (`bunHerdrRunner`, the real `Bun.spawn`-backed runner body - no branch logic, cannot be unit-tested without a live process). `types.ts`, `registry.ts`, `curated.ts` are 100%/100%.
- Typecheck: `bunx tsc --noEmit` → clean, no output, exit 0.

## Requirement Fulfillment

### DW-2.1
PREMISE:  each `HerdrClient` method (incl. `workspaceList`) spawns the right `herdr … --json` and returns typed, parsed results matching the seam types (`Agent{agent,sessionId,status,cwd,workspaceId,tabId,paneId}`, `Workspace{id,label,cwd,tabCount,paneCount}`, `Session{name,default,running}`).
EVIDENCE: src/herdr/client.ts:203-319 (all 10 methods); src/herdr/types.ts:10-38 (seam types); test/herdr/client.test.ts:56-188 (`describe("HerdrClient - DW-2.1...")`, one test per method).
TRACE:    `client.agentList()` → argv `["agent","list"]` → stub returns `{result:{agents:[RAW_AGENT]}}` → `mapAgent` projects to `{agent,sessionId,status,cwd,workspaceId,tabId,paneId}` → test asserts `agents` equals `[MAPPED_AGENT]` (client.test.ts:57-67, ran, passed). Same pattern verified per-method for agentGet, agentRead, agentWait, workspaceCreate, workspaceFocus, paneRun, paneClose, sessionList. `workspaceList` specifically: argv `["workspace","list"]` then a follow-up `["pane","list","--workspace","w3"]` per workspace to derive `cwd` (client.ts:253-267); test asserts both calls and the final shape `{id,label,cwd,tabCount,paneCount}` (client.test.ts:110-134, ran, passed).
VERDICT:  PASS

### DW-2.2
PREMISE:  every failure mode in the Edge cases maps to a typed `HerdrError` (code + message); nothing throws a raw string.
EVIDENCE: src/herdr/client.ts:94-125 (`runHerdr` centralizes spawn/exit/parse failure normalization), :129-137 (`unwrapResult`), :145-184 (`mapAgent`/`mapWorkspaceFields`); `grep -n "throw " src/herdr/client.ts` → all 15 throw sites are `throw new HerdrError(...)` or a rethrow of an already-typed `HerdrError` (client.ts:249).
TRACE:    spawn throws `Error("spawn herdr ENOENT")` → caught client.ts:96-104 → `HerdrError("spawn_failed", ...ENOENT...)` (client.test.ts:191-202, ran, passed). Nonzero exit + `{"error":{code,message}}` stdout → `HerdrError(parsed.error.code, parsed.error.message)` verbatim (client.test.ts:204-215, ran, passed). Nonzero exit + plain text (covers both "unknown subcommand" and "server not running/connection error" shapes - same generic branch) → `HerdrError("command_failed", ...)` (client.test.ts:217-240, two variants, ran, passed). Exit 0 + malformed/empty stdout → `HerdrError("invalid_response", ...)` (client.test.ts:242-260, ran, passed). `agentWait` matching `/timed out/i` in either stderr or stdout → remapped from `command_failed` to `HerdrError("wait_timeout", ...)`; non-timeout failures stay `command_failed` (client.test.ts:262-294, ran, passed).
VERDICT:  PASS

### DW-2.3
PREMISE:  curated MCP tools registered via the `registerTool` harness, present in `tools/list` with input schemas (verify against the REAL server entrypoint, not only a bare McpServer in a unit test).
EVIDENCE: src/tools/curated.ts:22-108 (`registerCuratedTools`, 9 tools, every one via `registerTool(server, {...})`); src/server.ts:35 (`registerCuratedTools(server, createHerdrClient())` wired into the real entrypoint's `main()`); test/server.test.ts:59-81 (`DW_2_3_curated_herdr_tools_appear_in_the_real_servers_tools_list`, spawns `bun run src/server.ts` and lists tools over real stdio).
TRACE:    Independently spawned the real entrypoint (`bun run src/server.ts`) with a fresh MCP client (outside the existing test), called `tools/list`, and inspected the raw response for two curated tools. `herdr_agent_get` came back with `inputSchema: {type:"object", properties:{target:{type:"string"}}, required:["target"], additionalProperties:false, ...}`; `herdr_agent_wait` came back with the full `status` enum (`idle|working|blocked|unknown`) and a positive-integer constraint on `timeoutMs`. This directly confirms input schemas are present and correctly shaped against the real entrypoint, not merely a bare `McpServer` in a unit test. The existing `test/server.test.ts` run (50 pass, includes this test) separately confirms all 9 curated tool names are present in the real server's `tools/list`.
VERDICT:  PASS

### DW-2.4
PREMISE:  unit tests cover parse-success and each error normalization using a stubbed spawn (no live herdr).
EVIDENCE: test/herdr/client.test.ts:12-22 (`stubRunner` - injects canned `{stdout,stderr,exitCode}`, never touches `Bun.spawn`); :56-188 (parse-success per method); :190-295 (error normalization); :297-339, :341-435 (additional defensive-guard cases from a prior review-fix pass).
TRACE:    Every test in client.test.ts constructs `createHerdrClient(runner)` with a `stubRunner`/inline stub `HerdrRunner` - grepped the file for `Bun.spawn`/live-process usage: none present. All 27 tests in this file ran and passed under `bun test`.
VERDICT:  PASS

**All requirements met:** YES

## Test-DW Coverage
- [x] DW-2.1 - one test per `HerdrClient` method, all ran and passed (client.test.ts).
- [x] DW-2.2 - one test per failure-mode category (spawn failure, JSON error envelope, plain-text nonzero exit x2, malformed/empty stdout x2, wait-timeout x3), all ran and passed.
- [x] DW-2.3 - schema/registration presence verified two ways: unit test against bare `McpServer` (curated.test.ts, checks `inputSchema` truthy for all 9 tools) + real-entrypoint test (server.test.ts, tool names) + a direct real-entrypoint schema inspection I ran myself (see DW-2.3 trace above).
- [x] DW-2.4 - self-referential; satisfied by the client.test.ts suite itself, confirmed stub-only (no live herdr).
- [x] Coverage matches the stated 100%-of-unit-testable-code level: 99.16% lines, sole gap is the real `Bun.spawn` runner body (client.ts:50-56), the explicitly named legitimate exclusion.

## Dead Code
None found. Scanned all four implementation files for unused imports, unreachable code, debug `console.log` statements, and commented-out blocks - none present. The one `console.log` grep hit in server.ts:4 is a doc comment describing the *prohibition* on console.log, not a violation.

## Correctness Dimensions

| Dimension | Status | Evidence |
|-----------|--------|----------|
| Concurrency | N/A | No shared mutable state; `workspaceList`'s `Promise.all` over independent per-workspace `pane list` calls has no cross-call state to race on - each workspace's `firstPaneCwd` call is independent (client.ts:260-266). |
| Error Handling | PASS | Traced the four external-input failure axes (spawn throw, nonzero exit w/ JSON error, nonzero exit w/ plain text, exit-0 malformed JSON) through `runHerdr` (client.ts:94-125) plus the `agentWait` timeout reclassification (client.ts:238-251) - each produces a distinct, executed, typed `HerdrError`. Traced a compound adversarial case not directly in the DW list: `agent_session` present but not an object (e.g. a string) - `isRecord(raw.agent_session)` (client.ts:149) correctly falls through to `sessionId = ""` rather than crashing on `raw.agent_session.value`. |
| Resources | N/A | No file handles/connections/locks held across calls; each `herdr` invocation is a one-shot spawn via the injected `HerdrRunner`, awaited to completion before returning (client.ts:50-58). No pooling/caching to leak. |
| Boundaries | PASS | Traced `unwrapResult` against `result: {}` (key absent, not merely falsy) → distinct `invalid_response` re: `expected result.agent` (client.test.ts:342-353, ran, passed) vs. `mapAgent` against a bare-string array element → distinct `invalid_response` re: `expected an agent object` (client.test.ts:355-364, ran, passed) - both traced and both avoid the undefined-property-access crash a naive `.result.agent.foo` chain would hit. |
| Security | N/A | No untrusted-input-driven code execution, path traversal, or auth logic in this phase; `pane run`/`pane close` pass caller-supplied strings straight through as `herdr` argv elements (never shell-interpolated - `Bun.spawn(["herdr", ...argv])` is exec-array form, not a shell string), so no shell-injection surface from this phase's code. |

## Loaded-Skill Criteria

| Skill | Criterion | Status | Evidence |
|-------|-----------|--------|----------|
| aposd-designing-deep-modules | Interface depth: few methods hiding real complexity, not classitis/shallow wrappers | PASS | `HerdrClient` is 10 methods hiding argv construction, JSON envelope unwrapping, and 5+ distinct failure-mode normalizations behind one shared private executor (`runHerdr`) - client.ts:94-137. Callers (curated.ts) never see argv, envelopes, or raw herdr JSON; each curated-tool handler is a 1-3 line pass-through to the typed client (curated.ts:27-107). No single-caller methods, no information leakage of herdr's wire format past `client.ts`. |
| aposd-designing-deep-modules | No false abstraction / granularity mismatch pushed onto callers | PASS | Traced `workspaceList`: herdr's own `workspace list` doesn't expose `cwd`, so the client - not the caller - issues the extra `pane list` call and derives it (client.ts:253-267, documented at :322-328). Caller-facing `Workspace` type never leaks this two-call reality. |
| cc-defensive-programming | External input validated at entry (barricade); no undefined-access crashes on malformed data | PASS | Every `herdr` JSON response is validated via `isRecord`/`isErrorEnvelope`/`mapAgent`/`mapWorkspaceFields`/inline shape checks before any field access (client.ts:72-184, 301-317) - traced the "valid JSON, wrong-typed field" adversarial case (`agentGet` on `{agent:{agent:"claude"}}`, missing `cwd`/`workspace_id`/etc.) → `invalid_response`, not a crash (client.test.ts:330-338, ran, passed). MCP-facing curated-tool args are validated by zod schemas (curated.ts:17-19, 41-46, 53-57, 64-68, 75, 85, 95) before reaching the client. |
| cc-defensive-programming | No empty catch blocks | PASS | Only one `catch` in the reviewed files (client.ts:241 in `agentWait`) - it inspects the caught error and either rethrows a remapped `HerdrError` or rethrows the original; never swallowed. `registry.ts`'s catch (out of scope, given) logs to stderr and returns an `isError` result - also non-empty. |

## Notes (non-blocking)
- `client.ts:50-56` (`bunHerdrRunner`) is the only uncovered code; it is exactly the kind of thin, branchless `Bun.spawn` wrapper the review brief names as a legitimate exclusion from the 100% bar.
- `test/server.test.ts`'s `DW_2_3` test checks tool *names* only, not schema shape, against the real entrypoint. I closed that gap myself with a direct real-entrypoint schema inspection (see DW-2.3 trace) rather than treating it as blocking, since the underlying behavior is correct and now has execution evidence. Worth folding that schema assertion into the permanent test file in a future pass so the evidence is repeatable without ad hoc verification.
- `firstPaneCwd`'s documented empty-panes fallback (`cwd: ""`) is a deliberate, documented robustness choice (client.ts:322-328), not a defect - noted, not flagged.

## Issues (if FAIL)
None.

**Verdict: PASS**
