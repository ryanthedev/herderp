# Discovery + Design: Phase 1 - Scaffold + MCP server boot

## Files Found
- Repo root: only `.claude/`, `.code-foundations/`, `.git/`, `.gitignore`, and the leftover `.necrotest/` research artifact existed before this phase. No `package.json`, `tsconfig.json`, `bunfig.toml`, `.mcp.json`, `.claude-plugin/`, `src/`, or `test/` existed — this is a true greenfield scaffold.
- `.gitignore` already anticipates the stack: `node_modules/`, `dist/`, `*.log`, `.necrotest/` (soon dead weight since the dir itself is removed), `.claude/settings.local.json`.
- `.code-foundations/research/2026-07-09-herderp-plugin-necromancy.md` — the feasibility research doc; confirms the on-disk graveyard mechanics used in later phases (not this phase's concern, but read for context).
- Bun `1.3.14` installed at `/opt/homebrew/bin/bun` — confirms the "Bun runs the SDK stdio transport" assumption is testable, not just asserted.
- `@modelcontextprotocol/sdk@1.29.0` is the current published version (checked via `npm view`). Downloaded and inspected its `.d.ts` files directly (not from training memory) to ground the design:
  - `McpServer` (from `server/mcp.js`): constructor `(serverInfo: {name, version}, options?)`; `registerTool(name, config, cb)` is the current, non-deprecated registration method (the overloaded `.tool(...)` family is `@deprecated`); `connect(transport): Promise<void>`.
  - `config.inputSchema` is typed as `ZodRawShapeCompat = Record<string, AnySchema>` — a **raw shape** object (e.g. `{ foo: z.string() }`), not a constructed `z.object(...)`. This type is not re-exported from `server/mcp.js`'s public surface, so `registry.ts` defines its own local shape alias over `zod` directly rather than reaching into SDK internals.
  - `StdioServerTransport` (from `server/stdio.js`): reads stdin / writes stdout, `Transport` interface, no built-in stdout hygiene guard — that's on us.
  - `Client` + `StdioClientTransport` (from `client/index.js`, `client/stdio.js`) let a test **spawn the real server as a child process and speak real JSON-RPC to it** (`initialize`, `listTools()`, `callTool()`) instead of hand-rolling protocol frames — this is the most faithful test of DW-1.1/DW-1.3 available without a live Claude Code host.
  - zod is a peer dependency (`^3.25 || ^4.0`), so it must be declared as an explicit `dependencies` entry in `package.json`, not assumed transitively.

## Current State
Nothing exists yet for this phase's scope. This is a pure build, not a modify.

## Gaps
- Plan's assumption "Claude Code plugin manifest = `.claude-plugin/plugin.json` + bundled stdio MCP registration" was Med confidence and explicitly flagged for verification. Verified via `claude-code-guide` agent against current official docs (`code.claude.com/docs/en/plugins.md`, `plugins-reference.md`):
  - Manifest: `.claude-plugin/plugin.json`, only `name` strictly required; `mcpServers` can be declared **either** inline in `plugin.json` **or** in a sibling `.mcp.json` at the **plugin root** (i.e., repo root here, NOT inside `.claude-plugin/`).
  - Chosen: separate `.mcp.json` at repo root (matches the plan's explicit file scope, which lists `.mcp.json` alongside `.claude-plugin/**` as distinct entries — the plan already assumed the two-file shape).
  - Critical gotcha confirmed: bundled paths must use `${CLAUDE_PLUGIN_ROOT}` (not a relative path) since the plugin's installed location can differ from this repo's dev path.
  - No other directories (`skills/`, `commands/`) are required for a minimal valid plugin — confirms Phase 1 can ship without them (skills/ arrives in Phase 4).
- No `docs/code-standards.md` exists yet (greenfield repo, no prior code to derive conventions from) — noted per Baseline Discipline; no conventions to violate, so this phase establishes the first ones (favor idiomatic Bun/TS: ESM, `.ts` extensionless imports resolved by Bun, named exports).
- Plan's second Med-confidence path ("Bun runs the SDK stdio transport cleanly", High confidence) is validated empirically by DW-1.1's own integration test (real spawn + real client), not just asserted.

## Code Standards
No `docs/code-standards.md` found — first code in the repo. Following idiomatic Bun + TypeScript conventions: ESM (`"type": "module"`), strict TS, named exports over default exports for the two produced seams (`createServer`, `registerTool`), stderr-only logging enforced by test.

## Test Infrastructure
None exists yet. `bun test` (Bun's built-in Jest-compatible runner, `describe`/`it`/`expect` from `bun:test`) is the wiring target per DW-1.4. Chosen test strategy:
1. **Integration test** (`test/server.test.ts`): spawns `bun run src/server.ts` via the SDK's own `StdioClientTransport` + `Client`, performs a real `initialize` + `listTools()` + `callTool()` round trip. This is the strongest available proof for DW-1.1 and DW-1.3 — it exercises the real protocol, not a mock.
2. **Stdout hygiene test** (dirty, T1.5-equivalent): capture the child process's raw stdout stream independently of the JSON-RPC framing and assert every line parses as JSON (i.e., nothing non-JSON-RPC — like a stray `console.log` — leaked onto stdout).
3. **Unit test** (`test/registry.test.ts`): constructs a bare `McpServer`, calls `registerTool`, and asserts the tool appears in `server.server`'s registered-tools listing and that calling it through the SDK returns the expected wrapped result; also covers the harness's error-normalization path (handler throws → `isError: true`, not an uncaught exception).
4. **Manifest schema test** (`test/plugin-manifest.test.ts`): static structural validation of `.claude-plugin/plugin.json` and `.mcp.json` against the field shapes confirmed above (`name` present, `mcpServers.<key>.command` present, uses `${CLAUDE_PLUGIN_ROOT}`). This is a static/schema check — actually loading the manifest into a running Claude Code host isn't automatable in this environment, and the discovery notes that limit explicitly rather than silently overclaiming "plugin loads" as machine-verified.

## DW Verification

| DW-ID | Done-When Item | Status | Test Cases |
|-------|---------------|--------|------------|
| DW-1.1 | server entry starts over stdio and answers `initialize` + `tools/list` without error (stdout carries only JSON-RPC) | COVERED | `test/server.test.ts`: "boots over stdio and answers initialize + tools/list"; "stdout carries only JSON-RPC frames (no stray logging)" |
| DW-1.2 | `.claude-plugin/plugin.json` (schema verified against Claude Code docs) declares the plugin and registers the stdio MCP server; plugin loads with no manifest error | COVERED (static schema level; see honest limit above) | `test/plugin-manifest.test.ts`: "plugin.json has required name field"; "`.mcp.json` declares the herderp stdio server with `${CLAUDE_PLUGIN_ROOT}`-relative command" |
| DW-1.3 | `registerTool()` registers a `{name, description, inputSchema, handler}` def; a stub tool appears in `tools/list` and returns on call | COVERED | `test/server.test.ts`: "stub tool appears in tools/list and returns a result on call"; `test/registry.test.ts`: "registerTool registers a tool visible on the server and invokes the handler" |
| DW-1.4 | `bun test` runs green (zero or a smoke test); `bun run` boots the server | COVERED | Full `bun test` suite passing is the direct proof; `test/server.test.ts` spawning `bun run src/server.ts` as the child process doubles as the "`bun run` boots the server" proof |
| DW-1.5 | leftover `.necrotest/` research artifact removed; repo tree clean | COVERED (done ahead of implementation, see below) | Verified directly: `.necrotest/` removed via `rm -r` during discovery (no permission block encountered this run); confirmed absent by `find`/`grep` check |

**All items COVERED:** YES

## Design Decisions

### Design: `registerTool` harness

The plan pins the call signature — `registerTool(server, { name, description, inputSchema, handler })` — as a cross-phase seam; Phases 2–3 will call it ~12 more times to register herdr and necromancy tools. What's actually open for design is what the harness *hides* on the caller's behalf.

#### Approaches Considered
1. **Thin pass-through** — `registerTool` is a one-line forward to `server.registerTool(name, {description, inputSchema}, handler)`. Callers' handlers must themselves know and produce the SDK's `CallToolResult` content-array shape and must catch their own errors into `isError` results.
2. **Deep wrapper (chosen)** — `registerTool` still forwards to `server.registerTool`, but the wrapping layer (a) lets handlers return a plain JS value (object or string) and auto-wraps it into `{content:[{type:"text", text: ...}]}` (JSON-stringifying objects), and (b) catches any thrown error, logs the full error to **stderr only**, and returns a typed `{content:[...], isError:true}` result instead of letting the exception escape and potentially crash the stdio process or print to stdout.
3. **Full registry class** — a stateful `ToolRegistry` tracking definitions in a `Map`, offering `listTools()`, deferred/batch registration, re-registration guards, etc. Rejected: `McpServer` already owns tool bookkeeping and serves `tools/list` itself; a parallel registry would duplicate that state (information leakage) for no benefit Phase 1 needs — classic classitis risk this early.

#### Comparison
| Criterion | 1. Thin pass-through | 2. Deep wrapper | 3. Registry class |
|-----------|---|---|---|
| Interface simplicity | Same 4-field signature | Same 4-field signature | New class + methods, more surface |
| Information hiding | Low — every future tool re-learns `CallToolResult` shape and error convention | High — content-array shape and error convention hidden in one place | High, but duplicates SDK's own bookkeeping |
| Caller ease of use | Every Phase 2/3 tool handler repeats boilerplate (~12 call sites) | Phase 2/3 handlers just `return {…plainData}` or `throw` | Same ease as #2 plus unused introspection API |
| Stdout/stderr safety (DW-1.1 edge case) | Not enforced — a handler could easily `console.log` a debug value straight onto stdout | Centralizes the one place errors are logged, making "stderr only" a harness-level invariant instead of per-handler discipline | Same as #2 |

#### Choice: 2 — Deep wrapper
Rationale: the 4-field call signature is fixed by the plan, so the only design lever left is what's inside. Centralizing content-wrapping and error normalization pays off precisely because Phase 2 alone adds ~9 more `registerTool` call sites and Phase 3 adds 3 more — repeating SDK response-shape and error-catching logic at every one of those call sites is the "Information Leakage" red flag the design skill warns about. Sacrifice: the wrapper makes one opinionated choice (plain-object-in, JSON-text-out) that a handler needing raw multi-content-block responses (e.g. images) would have to bypass — acceptable for Phase 1–3's all-JSON-data tools; revisit if a later phase needs non-text content blocks.

#### Depth Check
- Interface methods: 1 (`registerTool`), plus `createServer`.
- Hidden details: SDK's `CallToolResult` content-array wrapping; error-to-`isError` conversion; stderr-only error logging; the SDK's raw-zod-shape input type.
- Common case complexity: simple — a Phase 2/3 tool handler is `async (args) => ({ ...data })` or a thrown error, nothing else.

### `createServer(): McpServer`
Kept intentionally minimal: constructs a bare `McpServer` with `{name: "herderp", version}` and no tools pre-registered, so it's reusable by both the real entry point and by unit tests that want a clean server to register test tools against. The stub tool ("`herderp_ping`") is registered by the entry point (`main()` in `src/server.ts`), not inside `createServer`, keeping "create a server" and "populate it with this phase's specific stub tool" as separate concerns — avoids conflating scaffolding with a scope item (the stub) that later phases don't need repeated.

### Entry point / stdio hygiene
`main()` only ever writes to stdout via the SDK transport itself (which owns stdout exclusively once connected); every diagnostic (startup line, uncaught top-level error) goes through `console.error` (stderr). Guarded by `import.meta.main` so importing `src/server.ts` from tests doesn't also boot a live transport.

## Prerequisites
- [x] Required files do not yet exist — created fresh in this phase (expected for a greenfield scaffold).
- [x] Bun 1.3.14 available and confirmed able to run the SDK (validated empirically via the integration test, not just assumed).
- [x] `@modelcontextprotocol/sdk` version and API surface confirmed by inspecting the installed package's `.d.ts` files directly.
- [x] Claude Code plugin manifest schema confirmed against current official docs (not the Med-confidence guess from the plan).
- [x] `.necrotest/` removed.

## Recommendation
BUILD. No blockers, no scope gaps. Proceed to stub → implement → validate.
