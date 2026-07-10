# Plan: herderp — herdr Claude plugin + session necromancy

**Created:** 2026-07-09
**Status:** in-progress
**Started:** 2026-07-09 22:24
**Current Phase:** 2
**Complexity:** medium

---

## Context

`herderp` is a greenfield Claude Code plugin. It needs (1) a Bun/TypeScript **stdio MCP server** wrapping the `herdr` CLI with curated typed tools for one-shot agent/workspace/pane/session ops, and (2) a **necromancy** capability — MCP tools with a thin skill on top — that takes a flexible "space" target (workspace id, label, cwd, session name, or nothing → help find one), lists the revivable Claude Code sessions that lived there from the on-disk graveyard, previews them, and resurrects a chosen one via `claude --resume` in a herdr pane.

Feasibility is confirmed by a live end-to-end test (see research doc `.code-foundations/research/2026-07-09-herderp-plugin-necromancy.md`): start → kill (pane close; jsonl survives) → `herdr pane run <pane> 'claude --resume <uuid>'` restores the session and herdr re-reports the same id.

## Constraints

- **Stack:** Bun + TypeScript, `@modelcontextprotocol/sdk`, stdio transport; packaged as a Claude Code plugin (manifest + `skills/` + MCP registration).
- **herdr access:** CLI shell-out (`herdr <sub> --json`), behind a single client interface so a socket backend can drop in later. No direct socket in v1.
- **Logic home:** deterministic necromancy logic (slug, graveyard scan, ranking, preview, resume orchestration) lives in the MCP server and is `bun test`-covered; the skill only handles find-a-space / preview / pick UX.
- **Verified mechanics (must honor):** revivable sessions enumerated from disk `~/.claude/projects/<slug>/*.jsonl` (authoritative); slug = each `/` **and** `.` → `-`; resume via `herdr pane run <pane> 'claude --resume <uuid>'` in the target cwd; **wait for herdr detection** after launch (herdr tags an agent only after its first turn, not at boot); tolerate live herdr ids with no on-disk file.
- **v1 scope:** Claude agents only (leave seams for others); resume-only (restore conversation, not pane geometry).
- **Environment:** requires `herdr` server running + `~/.claude/projects`; degrade gracefully (clear message, no crash) if absent.

## Chosen Approach

**A — CLI shell-out.** The MCP spawns `herdr <sub> --json` per call and parses stdout, all behind one `HerdrClient` interface. Chosen for simplicity, resilience to herdr internals, and because `--json` is herdr's stable public contract; per-call spawn cost is negligible for one-shot/necromancy volume. **Fallback:** if latency or streaming needs arise, swap in a socket-backed `HerdrClient` implementation without touching tools or necromancy core.

## Rejected Approaches

- **B — Direct socket protocol:** talks herdr's unix-socket JSON (protocol v14) directly. Rejected for v1 — couples to an internal framing, reimplements the CLI, more code, for latency wins that one-shot usage doesn't need.

---

## Implementation Phases

### Phase 1: Scaffold + MCP server boot
**Model:** sonnet
**Skills:** code-foundations:aposd-designing-deep-modules
**Gate:** Standard
**Depends on:** none
**File scope:** `package.json, tsconfig.json, bunfig.toml, .mcp.json, .claude-plugin/**, src/server.ts, src/registry.ts, test/**`

**Goal:** Stand up the Bun/TypeScript Claude-plugin skeleton with a stdio MCP server that boots and exposes a tool-registration harness (a deep `registerTool` interface hiding SDK wiring from callers).

**Scope:**
- IN: Bun + TS project (package.json, tsconfig, `bun test` wired); `@modelcontextprotocol/sdk` stdio server; `.claude-plugin/plugin.json` manifest + MCP registration; a `registerTool()` convention; one stub tool proving the pipe; remove the leftover `/Users/r/repos/herderp/.necrotest/` research artifact.
- OUT: any herdr calls, any necromancy logic.

**Edge cases:** manifest schema wrong → plugin fails to load (verify schema against docs first); server must speak stdio cleanly (no stray stdout logging that corrupts JSON-RPC — log to stderr only).

**File hints:** `src/server.ts` — stdio server entry + `createServer`; `src/registry.ts` — `registerTool` harness; `.claude-plugin/plugin.json` — plugin manifest + MCP registration.

**Produces:** `createServer(): McpServer`; `registerTool(server, { name, description, inputSchema, handler })` convention; plugin manifest at `.claude-plugin/plugin.json` registering the stdio server. Consumed by Phases 2–3 to register tools.

**Done when:**
- [ ] DW-1.1: server entry starts over stdio and answers `initialize` + `tools/list` without error (stdout carries only JSON-RPC).
- [ ] DW-1.2: `.claude-plugin/plugin.json` (schema verified against Claude Code docs) declares the plugin and registers the stdio MCP server; plugin loads with no manifest error.
- [ ] DW-1.3: `registerTool()` registers a `{name, description, inputSchema, handler}` def; a stub tool appears in `tools/list` and returns on call.
- [ ] DW-1.4: `bun test` runs green (zero or a smoke test); `bun run` boots the server.
- [ ] DW-1.5: leftover `.necrotest/` research artifact removed; repo tree clean.

**Difficulty:** LOW
**Uncertainty:** exact Claude Code plugin manifest + MCP-registration schema (verify before building).

### Phase 2: herdr client + curated tools
**Model:** sonnet
**Skills:** code-foundations:aposd-designing-deep-modules, code-foundations:cc-defensive-programming
**Gate:** Standard
**Depends on:** Phase 1
**File scope:** `src/herdr/**, src/tools/curated.ts, test/herdr/**`

**Goal:** Build one deep `HerdrClient` module that hides CLI shell-out + JSON parsing + error normalization, and register curated MCP tools over it.

**Scope:**
- IN: `HerdrClient` (spawn `herdr <sub> --json`, parse, normalize errors); curated tools for agent list/get/read/wait, workspace create/focus, pane run/close, session list; unit tests with a stubbed spawn.
- OUT: necromancy logic; live-herdr integration tests (Phase 4).

**Edge cases (external boundary — CLI output validated at entry):** herdr server not running (socket absent / connection error); nonzero exit; error-shaped JSON `{"error":{code,message}}`; malformed/partial stdout; unknown subcommand; `agentWait` timeout. All normalized to a typed `HerdrError`, never a raw throw of stdout.

**Security-sensitive:** no — decided consciously. The CLI output is the user's own local `herdr` process, not untrusted network/external input; `JSON.parse` of a trusted local tool is not the deserialization threat the doctrine targets. Input is still validated at entry per defensive-programming (typed `HerdrError`), but this does not rise to the security gate. (Command construction from an id — the real injection surface — lives in Phase 3, which IS marked Security-sensitive.)

**File hints:** `src/herdr/client.ts` — `HerdrClient` (spawn/parse/normalize); `src/herdr/types.ts` — result types; `src/tools/curated.ts` — curated tool registrations.

**Produces:** `HerdrClient` interface —
- `agentList(): Promise<Agent[]>`, `agentGet(target): Promise<Agent>`, `agentRead(target, opts): Promise<string>`, `agentWait(target, {status, timeoutMs}): Promise<Agent>`
- `workspaceList(): Promise<Workspace[]>`, `workspaceCreate({cwd, label?, focus?}): Promise<Workspace>`, `workspaceFocus(id): Promise<void>`
- `paneRun(paneId, command): Promise<void>`, `paneClose(paneId): Promise<void>`
- `sessionList(): Promise<Session[]>`

Seam types (minimal fields Phase 3 depends on):
- `Agent { agent: string; sessionId: string /* from agent_session.value */; status: "idle"|"working"|"blocked"|"done"|"unknown"; cwd: string; workspaceId: string; tabId: string; paneId: string }`
- `Workspace { id: string; label: string|null; cwd: string /* identity_cwd */; tabCount: number; paneCount: number }`
- `Session { name: string; default: boolean; running: boolean }`

Consumed by Phase 3's `findSpaces` (workspaceList + agentList) and resume orchestration (workspaceCreate + paneRun + agentWait); `paneClose` supports teardown (Phase 4 e2e rollback).

**Done when:**
- [ ] DW-2.1: each `HerdrClient` method (incl. `workspaceList`) spawns the right `herdr … --json` and returns typed, parsed results matching the seam types.
- [ ] DW-2.2: every failure mode in Edge cases maps to a typed `HerdrError` (code + message); nothing throws a raw string.
- [ ] DW-2.3: curated MCP tools registered via Phase 1's harness, present in `tools/list` with input schemas.
- [ ] DW-2.4: unit tests cover parse-success and each error normalization using a stubbed spawn (no live herdr).

**Difficulty:** MEDIUM
**Uncertainty:** exact JSON envelope varies per subcommand (some wrap in `{id,result}`, some bare) — client must handle both shapes.

### Phase 3: Necromancy core + tools
**Model:** fable
**Skills:** code-foundations:aposd-designing-deep-modules, code-foundations:cc-defensive-programming
**Gate:** Full
**Security-sensitive:** yes
**Depends on:** Phase 2
**File scope:** `src/necromancy/**, src/tools/necromancy.ts, test/necromancy/**`

**Goal:** Implement the deterministic necromancy core (slug, graveyard scan, ranking, preview, resume orchestration) as a deep module and expose it as MCP tools.

**Scope:**
- IN: `deriveSlug`, `findSpaces`, `listSessions`, `revive`; the three MCP tools; unit tests with stubbed FS + `HerdrClient`.
- OUT: interactive UX / pick loop (that's the skill, Phase 4); non-Claude agents.

**Edge cases:** missing `~/.claude/projects`; empty space; malformed/huge/empty `.jsonl` (skip, don't crash); **sessionId not a UUID → reject before building any `claude --resume <id>` command (injection guard)**; sessionId with no on-disk file (miss case) tolerated — disk is authoritative; herdr detection never arrives → bounded wait, return `detected:false`; workspace/pane create failure → typed error; subagent sessions nested under `<slug>/<parent>/subagents/` excluded in v1 (noted).

**File hints:** `src/necromancy/core.ts` — `deriveSlug`/`findSpaces`/`listSessions`/`revive`; `src/necromancy/preview.ts` — jsonl preview parse; `src/tools/necromancy.ts` — the three tool registrations.

**Produces:** MCP tools — `necromancy_find_spaces` → `{spaces:[{cwd,label?,workspaceId?,sessionCount,lastActivity}]}`; `necromancy_list_sessions({space})` → `{sessions:[{id,cwd,mtime,live,preview,messageCount}]}`; `necromancy_revive({sessionId,cwd})` → `{workspaceId,paneId,sessionId,detected}`. Core fns exported for the skill and tests. Consumes Phase 2's `HerdrClient` (`workspaceList`+`agentList` for `findSpaces`; `workspaceCreate`+`paneRun`+`agentWait` for `revive`) and Phase 1's `registerTool` (transitively via Phase 2).

**Done when:**
- [ ] DW-3.1: `deriveSlug(cwd)` maps each `/` and `.` → `-` (`/Users/r/repos/herderp/.necrotest` → `-Users-r-repos-herderp--necrotest`).
- [ ] DW-3.2: `findSpaces()` enumerates `~/.claude/projects/*`, joins with live workspaces by cwd, returns cwd/label/sessionCount/lastActivity per space.
- [ ] DW-3.3: `listSessions(cwd)` enumerates `<slug>/*.jsonl`, ranks by mtime desc, marks live vs dead (via `agentList`), adds preview + messageCount, excludes the nested `subagents/` dir, and skips malformed/empty/oversized files without crashing.
- [ ] DW-3.4: `revive(sessionId,cwd)` validates the UUID, creates a workspace, runs `claude --resume <id>` via `paneRun`, waits (bounded) for detection, returns the seam object; workspace/pane create failures surface as a typed error, not a partial-state crash.
- [ ] DW-3.5: non-UUID or nonexistent-file id → typed rejection; herdr live-id with no file does not break `listSessions`.
- [ ] DW-3.6: the three MCP tools registered with I/O schemas, present in `tools/list`.
- [ ] DW-3.7: unit tests cover slug edge cases (dotted/hidden paths), ranking, miss case, malformed jsonl, and non-UUID rejection (stubbed FS + client).

**Difficulty:** HIGH
**Uncertainty:** preview extraction from jsonl (first user message vs summary line) — fallback to `herdr agent explain --file`.

### Phase 4: Necromancy skill + live e2e verification
**Model:** sonnet
**Skills:** oberskills:skill-craft, oberskills:prompt
**Gate:** Standard
**Depends on:** Phase 3
**File scope:** `skills/necromancy/**, test/e2e/**`

**Goal:** Author the `necromancy` skill that orchestrates the Phase 3 tools, and verify the whole chain live against a real herdr instance.

**Scope:**
- IN: `skills/necromancy/SKILL.md` (frontmatter + body driving find-a-space / list / preview / pick / revive); a live e2e verification (start → kill → revive); graceful-degradation messaging.
- OUT: evals/benchmark suite (skill-craft's full eval loop) — v1 ships with `validate_skill` clean + the live e2e; formal evals deferred.

**Edge cases:** herdr server down; `~/.claude/projects` absent; no revivable sessions in a space; target matches multiple spaces (disambiguate); target matches none (fall to find_spaces).

**File hints:** `skills/necromancy/SKILL.md` — the skill body + frontmatter; `test/e2e/revive.test.ts` — scripted start→kill→revive proof.

**Rollback:** the live e2e (DW-4.3) creates and kills a throwaway `claude` session in a temp cwd — additive and reversible: on completion close the created pane/workspace and remove the temp dir. No user data at risk (no point of no return).

**Produces:** `skills/necromancy/SKILL.md` + a passing live e2e proof (final user-observable deliverable).

**Done when:**
- [ ] DW-4.1: `skills/necromancy/SKILL.md` has valid frontmatter (name = dir, third-person description with triggers + near-miss exclusions) and passes `validate_skill` with zero errors.
- [ ] DW-4.2: body accepts a flexible target (workspace id / label / cwd / session / none) and, when none, calls `necromancy_find_spaces` and presents candidates; then list → preview → pick → `necromancy_revive`.
- [ ] DW-4.3: live e2e — start a throwaway `claude` session, kill it, revive through the tools, confirm the same session id reattaches with prior context present.
- [ ] DW-4.4: herdr-down and no-projects cases produce a clear message, not a crash.

**Difficulty:** MEDIUM
**Uncertainty:** skill trigger phrasing (tuned with `test_triggers` if activation is off).

---

## Test Coverage
**Level:** 100% — every done-when item covered; full unit coverage of the necromancy core + herdr client (stubbed spawn/FS), plus a live e2e in Phase 4.

## Test Plan

**Phase 1 (smoke/unit)**
- [ ] T1.1: server answers `initialize` + `tools/list` over stdio [DW-1.1]
- [ ] T1.2: `.claude-plugin/plugin.json` validates against schema; plugin loads [DW-1.2]
- [ ] T1.3: `registerTool()` → stub tool appears in `tools/list` and returns on call [DW-1.3]
- [ ] T1.4: `bun test` green; `bun run` boots server [DW-1.4]
- [ ] T1.5 (dirty): a stray `console.log` to stdout is caught/prevented — JSON-RPC stream stays clean (logging → stderr) [DW-1.1 boundary]
- [ ] T1.6: `.necrotest/` absent after Phase 1; repo tree clean [DW-1.5]

**Phase 2 (unit, stubbed spawn)**
- [ ] T2.1: each `HerdrClient` method spawns the correct `herdr … --json` argv and returns typed parsed results [DW-2.1]
- [ ] T2.2: both envelope shapes parse — `{id,result}` and bare JSON [DW-2.1]
- [ ] T2.3 (dirty): herdr server not running → typed `HerdrError` [DW-2.2]
- [ ] T2.4 (dirty): nonzero exit → `HerdrError` [DW-2.2]
- [ ] T2.5 (dirty): error-shaped JSON `{"error":{…}}` → `HerdrError`, not a success result [DW-2.2]
- [ ] T2.6 (dirty): malformed/partial stdout → `HerdrError`, never a raw string throw [DW-2.2]
- [ ] T2.7 (dirty): `agentWait` timeout → typed timeout error [DW-2.2]
- [ ] T2.8: curated tools present in `tools/list` with input schemas [DW-2.3]

**Phase 3 (unit, stubbed FS + client)**
- [ ] T3.1: `deriveSlug` maps `/` and `.` → `-`; boundary cases (dotted/hidden path, multiple dots, trailing slash) [DW-3.1]
- [ ] T3.2: `findSpaces` joins disk + live workspaces; covers a space with sessions and a space with none [DW-3.2]
- [ ] T3.3: `listSessions` ranks by mtime desc and marks live vs dead [DW-3.3]
- [ ] T3.4 (dirty): `listSessions` skips malformed/empty jsonl and handles a very large jsonl without crashing or loading it whole [DW-3.3]
- [ ] T3.5: `revive` validates UUID → create → `paneRun` → bounded wait → seam object [DW-3.4]
- [ ] T3.6 (dirty): `revive` non-UUID id → typed rejection; assert no `claude --resume` command was constructed (injection guard) [DW-3.5]
- [ ] T3.7 (dirty): `revive` UUID with no on-disk file → typed rejection [DW-3.5]
- [ ] T3.8 (dirty): herdr live-id with no file → `listSessions` still returns, no crash [DW-3.5]
- [ ] T3.9 (dirty): detection never arrives within timeout → returns `detected:false` [DW-3.4]
- [ ] T3.10 (dirty): missing `~/.claude/projects` → typed/empty result, no crash [DW-3.2]
- [ ] T3.11: three necromancy tools present with I/O schemas [DW-3.6]
- [ ] T3.12 (dirty): `revive` when `workspaceCreate`/`paneRun` fails → typed error surfaced, no partial-state crash [DW-3.4]
- [ ] T3.13: subagent sessions under `<slug>/<parent>/subagents/` are excluded from `listSessions` output [DW-3.3]

**Phase 4 (integration + live e2e)**
- [ ] T4.1: `validate_skill` returns zero errors on `SKILL.md` [DW-4.1]
- [ ] T4.2 (manual walkthrough): dry-run the skill's documented flow by invoking the underlying tools in the specified order — none-target → `necromancy_find_spaces` → `necromancy_list_sessions` → preview → `necromancy_revive` — confirming each call succeeds in sequence (skill prose exercised, not an automated mock) [DW-4.2]
- [ ] T4.3 (live e2e): start → kill → revive a real throwaway session; same id reattaches with prior context [DW-4.3]
- [ ] T4.4 (dirty, manual): herdr down + `~/.claude/projects` absent → clear message, no crash [DW-4.4]
- [ ] T4.5 (manual): target string matching multiple spaces → skill disambiguates rather than guessing [DW-4.2 edge]

---

## Assumptions

| Assumption | Confidence | Verify Before Phase | Fallback If Wrong |
|---|---|---|---|
| Claude Code plugin manifest = `.claude-plugin/plugin.json` + bundled stdio MCP registration | Med | Phase 1 | Consult claude-code-guide / plugin docs for exact schema |
| Bun runs `@modelcontextprotocol/sdk` stdio transport cleanly | High | Phase 1 | Fall back to Node runtime |
| `herdr pane run <pane> 'claude --resume <id>'` resumes and herdr realigns the id | High (verified live) | Phase 3 | `herdr agent start … -- claude --resume <id>` argv form |
| Session preview is extractable from the jsonl (first user msg / summary) | Med | Phase 3 | Use `herdr agent explain --file <path>` |
| `herdr agent list` reliably marks which sessions are live | High (verified) | Phase 3 | Cross-check by pane presence |

## Decision Log

| Decision | Alternatives Considered | Rationale | Phase |
|---|---|---|---|
| herdr access via CLI shell-out | Direct socket protocol | `--json` is the stable public contract; simplest, resilient; spawn cost negligible | all |
| Necromancy logic in the MCP server | In the skill | Unit-testable, deterministic, reusable | 3 |
| Curated + necromancy tools | Generic `herdr` passthrough only | One-shot ergonomics + typed schemas | 2, 3 |
| Enumerate sessions from disk (authoritative) | Trust herdr live ids | Verified the live-id→file map isn't total (~92%) | 3 |
| Validate sessionId as UUID before command construction | Interpolate directly | Prevent shell/command injection into `claude --resume` | 3 |

---

## Notes
- **Detection lag:** herdr tags an agent only after its first model turn, not at boot — `revive` polls with a bounded wait and returns `detected` (may be false if slow); the skill surfaces that honestly.
- **Slug rule:** each `/` and each `.` in the absolute cwd → `-` (so `/.` → `--`).
- **Subagent sessions** nest under `~/.claude/projects/<slug>/<parent-uuid>/subagents/agent-<id>.jsonl` — excluded from v1 listing; revisit later.
- **Live-id miss case:** a herdr-reported session id may have no on-disk file (`/clear`/compaction rotates the id) — never let it break enumeration.
- Leftover `/Users/r/repos/herderp/.necrotest/` from research testing (rm was permission-blocked) — clean up during Phase 1.
- v1 is Claude-only; other agent kinds are a later seam.

---

## Execution Log

### Phase 1: Scaffold + MCP server boot (Gate: Standard)
- [x] BUILD: Discovery + design + implementation (stub → implement → validate) complete
- [x] REVIEW: Verification passed
- [x] Committed
Commit: af93b19
Summary: Bun/TS Claude-plugin skeleton with a stdio MCP server that boots and answers initialize/tools/list; exposes `createServer()` and a deep `registerTool(server, {name, description, inputSchema, handler})` harness (stderr-only logging, error normalization); `.claude-plugin/plugin.json` + `.mcp.json` registration verified against docs; 10 tests green. Phases 2–3 register tools through `registerTool`.
