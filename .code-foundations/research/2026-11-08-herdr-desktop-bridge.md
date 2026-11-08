# herderp as a bridge between herdr (TUI) and Herdr.app (herdr-core)

Date: 2026-11-08. Branch base: `feat/agent-watch`.

## Decisions (from the user)

- **Support both engines** and bridge them. The old `herdr` TUI server stays supported.
- **Unified tools.** Keep `herdr_agent` / `herdr_pane` / `herdr_tab` / `herdr_workspace`. Lists return both engines; each row carries `engine: "herdr" | "core"`.
- **Bridge = cross-engine control plus adoption.** Adoption moves a Claude session from an old herdr pane into a Herdr.app space.

## The two engines (verified live 2026-11-08)

| | herdr (TUI) | herdr-core + Herdr.app |
|---|---|---|
| Binary | `herdr` 0.9.0 | `hc` (= `herdr-core`) 0.1.18; layout via `herdr-app` |
| Socket | `~/.config/herdr/herdr.sock` | `~/.local/state/herdr-core/default/default.sock` |
| Self id in a terminal | `HERDR_WORKSPACE_ID`, pane env | `HC_TERMINAL_ID` (e.g. `t3s`), `HC_TERMINAL_SOCKET` |
| Structure | workspace > tab > pane | space > tab > pane (pane shows a terminal `tNN` or a mod) |
| Agent status | herdr's detector | OSC 7501 report: `idle working done blocked error`, plus `turn`, `title` |
| Remote | herderp `hosts.json` + ssh | built in: `hc machine ls`, address `machine/t7`, `on` param |
| Events | `events.subscribe` on herdr socket | `events.subscribe` over `hc connect` (filters: `terminal`, `labels`, `children_of`) |

## Facts the design rests on

- **`hc ls --json` is trimmed** (address, agent, cwd, state, status, turn, where). The JSON-RPC `terminal.list` over `hc connect` returns full facts, including `foreground.pid`, `foreground.cwd`, `labels`, `parent`.
- **Session join:** `foreground.pid` -> `~/.claude/sessions/<pid>.json` -> `sessionId`. Verified on t3s only. Will not work for remote-machine terminals (pid and sessions dir are on the other box).
- **Space membership is labels:** `herdr.space=<id>`, `herdr.tab=<id>`, plus `where: "<space> / <tab>"`. A terminal started with those labels appears in the app; an unknown space id becomes a new space (AGENTS.md "The model").
- **hc already notifies a parent** about its children (finished, blocked, exited). The watch's value on core is agents that are not your children.
- **Protocol traps** (engram): replies on one `hc connect` are strictly in order; closing stdin drops in-flight replies; history reads take 1-12 s on idle agents; `size` events flap and must be ignored; `terminal.read {lines:0}` is the fast path.

## Proposed architecture

1. **`CoreClient`** (new, `src/core/client.ts`), same shape as `HerdrClient`: one injected runner, typed methods, every failure normalized to a `CoreError` with a code.
   - Data calls: one short-lived `hc connect` per call, holding stdin open until the reply with the request's id arrives, then closing. Avoids the in-order and EOF traps without a long-lived connection to babysit.
   - Layout calls: `herdr-app ls` and `herdr-app do <command> <json>`.
   - Slow calls (`terminal.read` with history, `send`, `wait`) each get their own process, so nothing queues behind them.
2. **Engine routing** (`src/bridge/route.ts`), syntactic and checked by tests:
   - `t[0-9a-z]+` or `<machine>/t...` -> core. `w...:p...` / `w...:t...` / `w...` -> herdr.
   - A bare name -> look it up in both; one hit wins, two hits fail with both candidates.
   - `host` on a core call maps to `on` / the `machine/` prefix, and to herderp hosts for herdr.
3. **Degrade, don't fail.** A list or necromancy join with one engine down returns the other's rows plus `degraded: ["herdr"]` (the existing `HerdrError -> degraded` pattern).
4. **Tool mapping**

   | Tool / action | herdr | core |
   |---|---|---|
   | agent list/get/read/wait | yes | `terminal.list/get/read/wait` |
   | agent prompt / send_keys | yes | `terminal.send` / `terminal.keys` |
   | agent focus | yes | `herdr-app do agent.focus` |
   | agent rename | yes | `terminal.label` (name) - to confirm |
   | agent start | in an existing pane | `herdr-app do tab.new/terminal.open --argv` |
   | agent interrupt | n/a (send_keys esc) | `terminal.interrupt` (new action, both) |
   | agent explain | yes | fails: `[unsupported_on_core]` |
   | agent watch | yes | yes, one Monitor command over both streams |
   | agent adopt (new) | source | destination |
   | pane split/close/focus/swap | yes | `pane.split/close/focus/swap` (core focuses by id) |
   | tab / workspace(space) list/create/rename/focus/close | yes | `herdr-app ls` + `tab.*` / `space.*` |
   | worktree | yes | fails: `[unsupported_on_core]` |

5. **Adoption** (`herdr_agent{action:"adopt", target, space?}`):
   - Resolve the herdr pane's `sessionId` and cwd (necromancy already does this).
   - Start `claude --resume <sessionId>` in the target space via `herdr-app do tab.new --space <id> --folder <cwd> --argv [...]`, or a new space named after the herdr workspace.
   - **Decided (user, 2026-11-08):** two live writers on one transcript is unsafe. Adopt **refuses while the old agent is working** (or blocked), and **closes the old herdr pane once the new core terminal is up** (the new terminal reports a status). If the new one fails to come up, the old pane stays open and the error names both.
6. **Necromancy:** the live join reads both engines; handles resolve against hc's `where` label as well as herdr's workspace:tab labels; "current space" uses `HC_TERMINAL_ID` -> `labels["herdr.space"]` when `HERDR_WORKSPACE_ID` is absent.
7. **Watch:** subscribe to both streams; lines keep today's vocabulary and gain the engine only when both engines have a target with the same name.

## Open items

- Session join for remote core terminals: out of scope for now; report `sessionId: null` with a reason.
- Confirm `terminal.label` can set the display name, and the exact `herdr-app do` reply shapes, before relying on them.
