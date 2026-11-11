// Tests for the bridged curated tools (src/tools/curated.ts + bridged.ts):
// routing between herdr and herdr-core, merged lists, degraded engines, and
// core-only / herdr-only actions. Stub clients only.

import { describe, expect, it } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCuratedTools } from "../../src/tools/curated.js";
import { cleanLaunch } from "../../src/bridge/cleanenv.js";
import type { CoreClient } from "../../src/core/client.js";
import { CoreError, type AppSpace, type CoreTerminal } from "../../src/core/types.js";
import type { HerdrClient } from "../../src/herdr/client.js";
import { HerdrError, type Agent } from "../../src/herdr/types.js";

const HERDR_AGENT: Agent = { agent: "claude", sessionId: "s-1", status: "idle", cwd: "/a", workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" };
const SPACE = `sp${"a".repeat(32)}`;
const TAB = `tb${"b".repeat(32)}`;
const PANE = `p${"c".repeat(32)}`;

function terminal(over: Partial<CoreTerminal> = {}): CoreTerminal {
  return {
    address: "t7", name: "review", state: "live", app: "claude-code", status: "working", blockedKind: null, message: "m",
    title: "", turn: 1, cwd: "/b", foreground: { pid: 7, argv: ["claude"], cwd: "/b" }, labels: {}, parent: null,
    spaceId: SPACE, tabId: TAB, where: "api / 1", machine: null, ...over,
  };
}
const SPACES: AppSpace[] = [
  { id: SPACE, name: "api", folder: "/b", machine: null, active: true, tabs: [{ id: TAB, name: "1", active: true, terminals: [{ terminal: "t7", pane: PANE, status: "working", app: "claude-code", name: "review" }] }] },
];

function setup(opts: { herdr?: Partial<HerdrClient>; core?: Partial<CoreClient>; env?: NodeJS.ProcessEnv } = {}) {
  const calls: string[] = [];
  const herdr = {
    agentList: async () => [HERDR_AGENT],
    agentGet: async (t: string) => {
      if (t === "w1:p1" || t === "lead") return HERDR_AGENT;
      throw new HerdrError("agent_not_found", `agent target ${t} not found`);
    },
    workspaceList: async () => [{ id: "w1", label: "api", cwd: "/a", tabCount: 1, paneCount: 1 }],
    agentSendKeys: async (t: string, keys: string[]) => void calls.push(`herdr.keys ${t} ${keys}`),
    ...opts.herdr,
  } as unknown as HerdrClient;
  const core = {
    terminalList: async () => ({ terminals: [terminal(), terminal({ address: "t8", app: "", status: null, name: null })], machines: [] }),
    terminalGet: async (t: string) => {
      if (t === "t7" || t === "review" || t === "ska/t7") return terminal({ address: t === "ska/t7" ? "ska/t7" : "t7" });
      throw new CoreError("not_found", `no terminal "${t}"`);
    },
    terminalRead: async () => ({ text: "screen", complete: false, how: "screen", why: "working" }),
    terminalSend: async (t: string, text: string) => (calls.push(`core.send ${t} ${text}`), { turn: 1, started: true, status: "idle", wait: null }),
    terminalInterrupt: async (t: string) => (calls.push(`core.interrupt ${t}`), { outcome: "stopped", key: "esc" }),
    appSpaces: async () => SPACES,
    appDo: async (command: string, args: Record<string, unknown>) => (calls.push(`app ${command} ${JSON.stringify(args)}`), { space: SPACE, terminal: "t9" }),
    ...opts.core,
  } as unknown as CoreClient;
  const server = new McpServer({ name: "t", version: "0" });
  registerCuratedTools(server, { clientFor: async () => herdr }, { core, sessions: async () => "core-session", env: opts.env ?? { HC_TERMINAL_ID: "t1" } });
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> }> })._registeredTools;
  async function call(name: string, args: Record<string, unknown>) {
    const result = await tools[name]!.handler(args, {});
    const text = result.content[0]!.text;
    return { isError: result.isError === true, text, body: result.isError ? {} : JSON.parse(text) };
  }
  return { call, calls };
}

describe("herdr_agent across engines", () => {
  it("list merges both engines, tagged, and skips core terminals that aren't agents", async () => {
    const { body } = await setup().call("herdr_agent", { action: "list" });
    expect(body.agents.map((a: { engine: string; target: string }) => `${a.engine}:${a.target}`)).toEqual(["herdr:w1:p1", "core:t7"]);
    expect(body.agents[1].sessionId).toBe("core-session");
    expect(body.degraded).toBeUndefined();
  });

  it("list degrades instead of failing when one engine is down", async () => {
    const { body } = await setup({ herdr: { agentList: async () => { throw new HerdrError("socket_unreachable", "no herdr"); } } }).call("herdr_agent", { action: "list" });
    expect(body.agents.map((a: { engine: string }) => a.engine)).toEqual(["core"]);
    expect(body.degraded).toEqual([{ engine: "herdr", code: "socket_unreachable", message: "no herdr" }]);
  });

  it("list fails only when every engine is down", async () => {
    const { isError, text } = await setup({
      herdr: { agentList: async () => { throw new HerdrError("socket_unreachable", "no herdr"); } },
      core: { terminalList: async () => { throw new CoreError("core_unreachable", "no core"); } },
    }).call("herdr_agent", { action: "list" });
    expect(isError).toBe(true);
    expect(text).toStartWith("[engines_unreachable]");
  });

  it("engine:'core' lists only core", async () => {
    const { body } = await setup().call("herdr_agent", { action: "list", engine: "core" });
    expect(body.agents.map((a: { engine: string }) => a.engine)).toEqual(["core"]);
  });

  it("a bare name found only in core goes to core; one found only in herdr goes to herdr, stamped", async () => {
    const s = setup();
    expect((await s.call("herdr_agent", { action: "get", target: "review" })).body.agent).toMatchObject({ engine: "core", target: "t7" });
    expect((await s.call("herdr_agent", { action: "get", target: "lead" })).body).toMatchObject({ engine: "herdr", agent: { paneId: "w1:p1" } });
  });

  it("a herdr-shaped target never touches core", async () => {
    const { body } = await setup({ core: { terminalGet: async () => { throw new Error("must not be called"); } } }).call("herdr_agent", { action: "get", target: "w1:p1" });
    expect(body).toMatchObject({ engine: "herdr" });
  });

  it("prompt on core sends through hc and rejects herdr-only `until`", async () => {
    const s = setup();
    expect((await s.call("herdr_agent", { action: "prompt", target: "t7", text: "go" })).body.ok).toBe(true);
    expect(s.calls).toContain("core.send t7 go");
    const bad = await s.call("herdr_agent", { action: "prompt", target: "t7", text: "go", until: "done" });
    expect(bad.text).toStartWith("[unsupported_on_core]");
  });

  it("read on core reports a partial read honestly", async () => {
    const { body } = await setup().call("herdr_agent", { action: "read", target: "t7", lines: 100 });
    expect(body).toMatchObject({ engine: "core", text: "screen", complete: false, why: "working" });
    expect(body.hint).toContain("only part came back");
  });

  it("host qualifies a core target", async () => {
    const { body } = await setup().call("herdr_agent", { action: "get", target: "t7", engine: "core", host: "ska" });
    expect(body).toMatchObject({ host: "ska", agent: { target: "ska/t7" } });
  });

  it("interrupt works on both engines", async () => {
    const s = setup();
    await s.call("herdr_agent", { action: "interrupt", target: "t7" });
    await s.call("herdr_agent", { action: "interrupt", target: "w1:p1" });
    expect(s.calls).toEqual(["core.interrupt t7", "herdr.keys w1:p1 esc"]);
  });

  it("rename and explain are herdr only", async () => {
    const s = setup();
    expect((await s.call("herdr_agent", { action: "explain", target: "t7" })).text).toStartWith("[unsupported_on_core]");
    expect((await s.call("herdr_agent", { action: "rename", target: "t7", name: "x" })).text).toStartWith("[unsupported_on_core]");
  });

  it("start goes to the caller's home engine and opens a terminal in the window", async () => {
    const s = setup();
    const { body } = await s.call("herdr_agent", { action: "start", kind: "claude", argv: ["-c"], cwd: "/b", place: "right" });
    expect(s.calls[0]).toBe(`app terminal.open ${JSON.stringify({ argv: cleanLaunch(["claude", "-c"]), folder: "/b", place: "right" })}`);
    expect(body.hint).toContain('target:"t9"');
  });

  it("an ambiguous bare name is refused, not guessed", async () => {
    const s = setup({ herdr: { agentGet: async () => HERDR_AGENT } });
    expect((await s.call("herdr_agent", { action: "get", target: "review" })).text).toStartWith("[ambiguous_target]");
  });

  it("watch plans one command across both engines", async () => {
    const { body } = await setup().call("herdr_agent", { action: "watch", targets: ["review", "w1:p1"] });
    expect(body.command).toContain("'core:t7' 'herdr:w1:p1'");
    expect(body.targets.map((t: { engine: string }) => t.engine)).toEqual(["core", "herdr"]);
  });
});

describe("layout tools across engines", () => {
  it("workspace list merges herdr workspaces and Herdr app spaces", async () => {
    const { body } = await setup().call("herdr_workspace", { action: "list" });
    expect(body.workspaces.map((w: { engine: string; workspaceId?: string; id?: string }) => `${w.engine}:${w.workspaceId ?? w.id}`)).toEqual([
      "herdr:w1",
      `core:${SPACE}`,
    ]);
  });

  it("a core space id routes tab and pane calls to the window", async () => {
    const s = setup();
    expect((await s.call("herdr_tab", { action: "list", workspaceId: SPACE })).body.tabs[0]).toMatchObject({ engine: "core", tabId: TAB, number: 1 });
    expect((await s.call("herdr_pane", { action: "get", paneId: PANE })).body.pane).toMatchObject({ terminal: "t7" });
    await s.call("herdr_tab", { action: "close", tabId: TAB });
    expect(s.calls.at(-1)).toBe(`app tab.close {"id":"${TAB}","confirmed":true}`);
  });

  it("pane run types into the pane's terminal", async () => {
    const s = setup();
    await s.call("herdr_pane", { action: "run", paneId: PANE, command: "ls" });
    expect(s.calls).toContain("core.send t7 ls");
  });

  it("an unknown core id is a named not_found", async () => {
    const { text } = await setup().call("herdr_pane", { action: "get", paneId: `p${"9".repeat(32)}` });
    expect(text).toStartWith("[not_found]");
  });

  it("workspace create in a Herdr app terminal makes a space on this machine", async () => {
    const s = setup();
    await s.call("herdr_workspace", { action: "create", cwd: "/repo", label: "api" });
    expect(s.calls[0]).toBe('app space.new {"folder":"/repo","name":"api","machine":""}');
  });

  it("workspace create from a herdr pane stays in herdr", async () => {
    let created = false;
    const s = setup({
      env: { HERDR_WORKSPACE_ID: "w1" },
      herdr: { workspaceCreate: async () => ((created = true), { id: "w2", label: null, cwd: "/repo", tabCount: 1, paneCount: 1, rootPaneId: "w2:p1" }) },
    });
    const { body } = await s.call("herdr_workspace", { action: "create", cwd: "/repo" });
    expect(created).toBe(true);
    expect(body.engine).toBe("herdr");
  });

  it("swap by pair and move are herdr only", async () => {
    const s = setup();
    expect((await s.call("herdr_pane", { action: "move", paneId: PANE, destination: "new-tab" })).text).toStartWith("[unsupported_on_core]");
    expect((await s.call("herdr_pane", { action: "swap", sourcePaneId: PANE, targetPaneId: PANE })).text).toStartWith("[unsupported_on_core]");
  });

  // --- regressions from the adversarial review ---------------------------------

  it("a remote host keeps layout calls on herdr (hosts.json is herdr's)", async () => {
    let split = false;
    const s = setup({ herdr: { paneSplit: async () => void (split = true) } });
    const { body } = await s.call("herdr_pane", { action: "split", splitDirection: "down", host: "devbox" });
    expect(split).toBe(true);
    expect(body).toMatchObject({ host: "devbox", engine: "herdr" });
    expect(s.calls.some((c) => c.startsWith("app "))).toBe(false);
  });

  it("core pane and tab lists keep only the named machine's rows", async () => {
    const { body } = await setup().call("herdr_pane", { action: "list", engine: "core", host: "ska" });
    expect(body.panes).toEqual([]);
    const local = await setup().call("herdr_tab", { action: "list", engine: "core", host: "local" });
    expect(local.body.tabs.length).toBe(1);
  });

  it("split rejects env/ratio/focus:false on core instead of dropping them", async () => {
    const s = setup();
    for (const extra of [{ env: ["A=1"] }, { ratio: 0.3 }, { focus: false }]) {
      const { text } = await s.call("herdr_pane", { action: "split", paneId: PANE, splitDirection: "right", ...extra });
      expect(text).toStartWith("[unsupported_on_core]");
    }
    expect(s.calls).toEqual([]);
  });
});

describe("herdr_agent fixes from review", () => {
  it("start with a space opens a tab there; paneId is refused on core", async () => {
    const s = setup();
    await s.call("herdr_agent", { action: "start", kind: "claude", workspaceId: SPACE, name: "x" });
    expect(s.calls[0]).toBe(`app tab.new ${JSON.stringify({ space: SPACE, argv: cleanLaunch(["claude"]), name: "x" })}`);
    const { text } = await s.call("herdr_agent", { action: "start", kind: "claude", workspaceId: SPACE, paneId: PANE });
    expect(text).toStartWith("[unsupported_on_core]");
  });

  it("start on herdr refuses Herdr app fields", async () => {
    const { text } = await setup({ env: { HERDR_WORKSPACE_ID: "w1" } }).call("herdr_agent", { action: "start", kind: "claude", name: "x", paneId: "w1:p1", cwd: "/x" });
    expect(text).toContain("Herdr app options");
  });

  it("a bare name found in core while herdr is down: get answers, send_keys is refused", async () => {
    const s = setup({ herdr: { agentGet: async () => { throw new HerdrError("socket_unreachable", "no herdr"); } } });
    expect((await s.call("herdr_agent", { action: "get", target: "review" })).body.agent.engine).toBe("core");
    const { text } = await s.call("herdr_agent", { action: "send_keys", target: "review", keys: ["esc"] });
    expect(text).toStartWith("[target_unresolved]");
    expect(s.calls).toEqual([]);
  });

  it("read rejects herdr-only options on core; herdr rejects lines 0", async () => {
    const s = setup();
    expect((await s.call("herdr_agent", { action: "read", target: "t7", source: "visible" })).text).toStartWith("[unsupported_on_core]");
    expect((await s.call("herdr_agent", { action: "read", target: "w1:p1", lines: 0 })).text).toContain("at least 1");
  });

  it("engines_unreachable labels each error by its own engine", async () => {
    const { text } = await setup({
      herdr: { agentList: async () => { await Bun.sleep(5); throw new HerdrError("socket_unreachable", "no herdr"); } },
      core: { terminalList: async () => { throw new CoreError("core_unreachable", "no core"); } },
    }).call("herdr_agent", { action: "list" });
    expect(text).toContain("herdr: [socket_unreachable]");
    expect(text).toContain("core: [core_unreachable]");
  });

  it("an engine that isn't installed leaves no degraded entry", async () => {
    const { body } = await setup({ core: { terminalList: async () => { throw new CoreError("not_installed", "no hc"); } } }).call("herdr_agent", { action: "list" });
    expect(body.agents.map((a: { engine: string }) => a.engine)).toEqual(["herdr"]);
    expect(body.degraded).toBeUndefined();
  });

  it("a pane whose terminal is back at its shell lists as a shell", async () => {
    const { body } = await setup({
      core: { terminalList: async () => ({ terminals: [terminal({ foreground: { pid: 1, argv: ["/bin/zsh", "-li"], cwd: "/b" } })], machines: [] }) },
    }).call("herdr_pane", { action: "list", workspaceId: SPACE });
    expect(body.panes[0]).toMatchObject({ terminal: "t7", agent: "", status: null });
  });
});

// 2026-11-11, booking on ska: a lead couldn't tell which agent it was, sent
// unsigned notes, and started agents the Herdr app never showed.
describe("who is who", () => {
  it("list marks the caller's own core row and says who you are", async () => {
    const { body } = await setup({ env: { HC_TERMINAL_ID: "t7" } }).call("herdr_agent", { action: "list" });
    expect(body.you).toEqual({ engine: "core", target: "t7", where: "api / 1" });
    expect(body.agents.filter((a: { you?: boolean }) => a.you).map((a: { target: string }) => a.target)).toEqual(["t7"]);
  });

  it("list marks the caller's herdr pane, also when herdr alone is listed", async () => {
    const env = { HERDR_PANE_ID: "w1:p1", HERDR_WORKSPACE_ID: "w1", HC_TERMINAL_ID: "t7" };
    const merged = (await setup({ env }).call("herdr_agent", { action: "list" })).body;
    expect(merged.you).toMatchObject({ engine: "herdr", target: "w1:p1" });
    expect(merged.agents.filter((a: { you?: boolean }) => a.you).map((a: { target: string }) => a.target)).toEqual(["w1:p1"]);
    const herdrOnly = (await setup({ env }).call("herdr_agent", { action: "list", engine: "herdr" })).body;
    expect(herdrOnly.you).toMatchObject({ engine: "herdr", target: "w1:p1", where: "w1" });
    expect(herdrOnly.agents[0].you).toBe(true);
  });

  it("outside both engines, no row is you and the list says so", async () => {
    const { body } = await setup({ env: {} }).call("herdr_agent", { action: "list" });
    expect(body.you).toMatchObject({ engine: null, target: null });
    expect(body.you.note).toContain("outside herdr and the Herdr app");
    expect(body.agents.some((a: { you?: boolean }) => a.you)).toBe(false);
  });

  it("a remote list never marks a local caller", async () => {
    const { body } = await setup({ env: { HC_TERMINAL_ID: "t7" } }).call("herdr_agent", { action: "list", host: "ska" });
    expect(body.agents.some((a: { you?: boolean }) => a.you)).toBe(false);
    expect(body.you.note).toContain("not on ska");
  });

  it("the caller's own core row is not marked when it is missing", async () => {
    const { body } = await setup({ env: { HC_TERMINAL_ID: "t99" } }).call("herdr_agent", { action: "list" });
    expect(body.you).toMatchObject({ engine: "core", target: "t99" });
    expect(body.you.note).toContain("missing from this list");
  });

  it("get marks you on both engines", async () => {
    expect((await setup({ env: { HC_TERMINAL_ID: "t7" } }).call("herdr_agent", { action: "get", target: "t7" })).body.agent.you).toBe(true);
    expect((await setup({ env: { HC_TERMINAL_ID: "t1" } }).call("herdr_agent", { action: "get", target: "t7" })).body.agent.you).toBeUndefined();
    const herdr = await setup({ env: { HERDR_PANE_ID: "w1:p1", HERDR_WORKSPACE_ID: "w1" } }).call("herdr_agent", { action: "get", target: "w1:p1" });
    expect(herdr.body.agent.you).toBe(true);
  });

  it("a core prompt is signed with the caller's terminal, so the agent sees who sent it", async () => {
    const sends: Array<Record<string, unknown> | undefined> = [];
    const core = { terminalSend: async (_t: string, _x: string, o?: Record<string, unknown>) => (sends.push(o), { turn: 1, started: true, status: "idle", wait: null }) };
    const signed = await setup({ env: { HC_TERMINAL_ID: "t3s" }, core: core as never }).call("herdr_agent", { action: "prompt", target: "t7", text: "go" });
    expect(sends[0]).toMatchObject({ caller: "t3s" });
    expect(signed.body.from).toBe("t3s");
    const unsigned = await setup({ env: {}, core: core as never }).call("herdr_agent", { action: "prompt", target: "t7", text: "go" });
    expect(sends[1]?.caller).toBeUndefined();
    expect(unsigned.body.from).toBeNull();
    expect(unsigned.body.fromNote).toContain("say who you are");
  });

  it("a slash command or ! line goes unsigned, so it still runs as a command", async () => {
    const sends: Array<Record<string, unknown> | undefined> = [];
    const core = { terminalSend: async (_t: string, _x: string, o?: Record<string, unknown>) => (sends.push(o), { turn: 1, started: true, status: "idle", wait: null }) };
    const s = setup({ env: { HC_TERMINAL_ID: "t3s" }, core: core as never });
    for (const text of ["/reload-plugins", "  /compact", "!git status"]) {
      const { body } = await s.call("herdr_agent", { action: "prompt", target: "t7", text });
      expect(body.from).toBeNull();
      expect(body.fromNote).toContain("runs as a command");
    }
    expect(sends.every((o) => o?.caller === undefined)).toBe(true);
    expect((await s.call("herdr_agent", { action: "prompt", target: "t7", text: "see /tmp/x" })).body.from).toBe("t3s");
  });

  it("a command for another machine's terminal is sent from that machine, so hc doesn't tag it", async () => {
    const execs: Array<{ machine: string; argv: string[] }> = [];
    const sends: string[] = [];
    const core = {
      terminalGet: async (t: string) => terminal({ address: t }),
      terminalSend: async (t: string) => (sends.push(t), { turn: 1, started: true, status: "idle", wait: null }),
      machineExec: async (machine: string, argv: string[]) => (execs.push({ machine, argv }), { code: 0, stdout: '{"started":true,"status":"done","turn":5}', stderr: "", timedOut: false }),
    };
    const s = setup({ env: { HC_TERMINAL_ID: "t3s" }, core: core as never });
    const remote = await s.call("herdr_agent", { action: "prompt", target: "ska/t7", engine: "core", text: "/reload-plugins" });
    expect(remote.body.sent).toMatchObject({ started: true, turn: 5 });
    expect(execs).toEqual([{ machine: "ska", argv: ["env", "-u", "HC_TERMINAL_ID", "-u", "HC_SCOPE", "hc", "send", "--json", "t7", "/reload-plugins"] }]);
    expect(sends).toEqual([]);
    await s.call("herdr_agent", { action: "prompt", target: "ska/t7", engine: "core", text: "plain words" });
    await s.call("herdr_agent", { action: "prompt", target: "t7", engine: "core", text: "/reload-plugins" });
    expect(sends).toEqual(["ska/t7", "t7"]);
    expect(execs.length).toBe(1);
  });

  it("a failed remote command send is an error, not a quiet success", async () => {
    const core = { machineExec: async () => ({ code: 1, stdout: "", stderr: "no terminal t7", timedOut: false }) };
    const { isError, text } = await setup({ core: core as never }).call("herdr_agent", { action: "prompt", target: "ska/t7", engine: "core", text: "/compact" });
    expect(isError).toBe(true);
    expect(text).toContain("no terminal t7");
  });

  it("creating in herdr from outside herdr warns that the Herdr app won't show it", async () => {
    const herdr = { workspaceCreate: async () => ({ workspace: { id: "w2" }, rootPane: { id: "w2:p1" } }), agentStart: async () => undefined };
    const fromApp = await setup({ env: { HC_TERMINAL_ID: "t1" }, herdr: herdr as never }).call("herdr_agent", { action: "start", kind: "claude", name: "x", paneId: "w1:p1" });
    expect(fromApp.body.engine).toBe("herdr");
    expect(fromApp.body.notice).toContain("NOT in the Herdr desktop app");
    const fromHerdr = await setup({ env: { HERDR_PANE_ID: "w1:p2", HERDR_WORKSPACE_ID: "w1" }, herdr: herdr as never }).call("herdr_agent", { action: "start", kind: "claude", name: "x", paneId: "w1:p1" });
    expect(fromHerdr.body.notice).toBeUndefined();
    const remote = await setup({ env: { HERDR_PANE_ID: "w1:p2", HERDR_WORKSPACE_ID: "w1" }, herdr: herdr as never }).call("herdr_agent", { action: "start", kind: "claude", name: "x", paneId: "w1:p1", host: "ska" });
    expect(remote.body.notice).toContain("on ska");
  });

  it("creating in the Herdr app carries no notice", async () => {
    const { body } = await setup({ env: { HC_TERMINAL_ID: "t1" } }).call("herdr_agent", { action: "start", kind: "claude" });
    expect(body.engine).toBe("core");
    expect(body.notice).toBeUndefined();
  });
});
