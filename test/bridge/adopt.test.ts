// Tests for adopt (src/bridge/adopt.ts): the safety rules around moving a
// Claude session from a herdr pane into the Herdr app. Fake clock, stub
// clients; nothing real is started or closed.

import { describe, expect, it } from "bun:test";
import { adoptAgent, type AdoptDeps } from "../../src/bridge/adopt.js";
import type { CoreClient } from "../../src/core/client.js";
import type { SessionLookup } from "../../src/core/sessions.js";
import { CoreError, type CoreTerminal } from "../../src/core/types.js";
import type { HerdrClient } from "../../src/herdr/client.js";
import { HerdrError, type Agent, type AgentStatus } from "../../src/herdr/types.js";

const SESSION = "869ea63f-3324-4e6b-8b42-754d33f4eb98";

function agent(status: AgentStatus, over: Partial<Agent> = {}): Agent {
  return { agent: "claude", sessionId: SESSION, status, cwd: "/repo", workspaceId: "w3", tabId: "w3:t1", paneId: "w3:p1", ...over };
}

function coreTerminal(over: Partial<CoreTerminal> = {}): CoreTerminal {
  return {
    address: "t4c", name: null, state: "live", app: "claude-code", status: "idle", blockedKind: null, message: "",
    title: "", turn: 0, cwd: "/repo", foreground: { pid: 1, argv: ["claude"], cwd: "/repo" }, labels: {},
    parent: null, spaceId: "sp1", tabId: "tb1", where: null, machine: null, ...over,
  };
}

interface Setup {
  statuses?: AgentStatus[]; // successive herdr agentGet answers
  source?: Partial<Agent>;
  terminals?: Array<CoreTerminal | CoreError>; // successive core terminalGet answers
  sessions?: Array<string | null>;
  reply?: Record<string, unknown>;
  /** What the step-4 re-check sees: an agent override, or an error. */
  recheck?: Partial<Agent> | Error;
  paneCloseError?: Error;
  killError?: Error;
  spaces?: unknown[];
}

function setup(s: Setup = {}) {
  const log: string[] = [];
  const statuses = [...(s.statuses ?? ["idle", "idle"])];
  const terminals = [...(s.terminals ?? [coreTerminal()])];
  const sessionAnswers = [...(s.sessions ?? [SESSION])];
  const herdr = {
    agentGet: async () => {
      const first = statuses.length === (s.statuses ?? ["idle", "idle"]).length;
      const status = statuses.length > 1 ? statuses.shift()! : statuses[0]!;
      if (!first && s.recheck instanceof Error) throw s.recheck;
      return agent(status, { ...s.source, ...(!first && s.recheck ? s.recheck : {}) });
    },
    workspaceGet: async () => ({ id: "w3", label: "adopt-test", cwd: "/repo", tabCount: 1, paneCount: 1 }),
    paneClose: async (id: string) => {
      log.push(`herdr.paneClose ${id}`);
      if (s.paneCloseError) throw s.paneCloseError;
    },
  } as unknown as HerdrClient;
  const core = {
    appDo: async (command: string, args: Record<string, unknown>) => {
      log.push(`app ${command} ${JSON.stringify(args)}`);
      if (command === "terminal.kill" && s.killError) throw s.killError;
      return command === "terminal.kill" ? { ok: true } : (s.reply ?? { space: "sp1", tab: "tb1", terminal: "t4c" });
    },
    appSpaces: async () => s.spaces ?? [],
    terminalGet: async () => {
      const next = terminals.length > 1 ? terminals.shift()! : terminals[0]!;
      if (next instanceof CoreError) throw next;
      return next;
    },
  } as unknown as CoreClient;
  const sessions: SessionLookup = async () => (sessionAnswers.length > 1 ? sessionAnswers.shift()! : sessionAnswers[0]!);
  let clock = 0;
  const deps: AdoptDeps = {
    herdr, core, sessions, readyTimeoutMs: 5_000, readyPollMs: 1_000,
    now: () => clock, sleep: async (ms) => void (clock += ms),
  };
  return { deps, log };
}

describe("adoptAgent", () => {
  it("resumes the session in a new space named after the herdr workspace, then closes the old pane", async () => {
    const { deps, log } = setup();
    const result = await adoptAgent({ target: "w3:p1" }, deps);
    expect(log[0]).toBe(`app space.new {"folder":"/repo","argv":["claude","--resume","${SESSION}"],"machine":"","name":"adopt-test"}`);
    expect(log.at(-1)).toBe("herdr.paneClose w3:p1");
    expect(result).toMatchObject({ sessionId: SESSION, resumedSessionId: SESSION, to: { terminal: "t4c", workspaceId: "sp1" } });
  });

  it("adds it as a tab when given a space", async () => {
    const { deps, log } = setup();
    await adoptAgent({ target: "w3:p1", workspaceId: "sp9", label: "moved" }, deps);
    expect(log[0]).toStartWith('app tab.new {"space":"sp9","folder":"/repo"');
    expect(log[0]).toContain('"name":"moved"');
  });

  for (const status of ["working", "blocked", "unknown"] as AgentStatus[]) {
    it(`refuses a ${status} agent and touches nothing`, async () => {
      const { deps, log } = setup({ statuses: [status] });
      const error = await adoptAgent({ target: "w3:p1" }, deps).catch((e) => e);
      expect(error.code).toBe("agent_busy");
      expect(log).toEqual([]);
    });
  }

  it("refuses a pane that isn't a Claude session", async () => {
    const { deps, log } = setup({ source: { agent: "", sessionId: "" } });
    expect((await adoptAgent({ target: "w8:pF" }, deps).catch((e) => e)).code).toBe("not_a_claude_session");
    expect(log).toEqual([]);
  });

  it("waits through no-status and no-session polls before closing the old pane", async () => {
    const { deps, log } = setup({
      terminals: [coreTerminal({ status: null }), coreTerminal(), coreTerminal()],
      sessions: [null, SESSION],
    });
    await adoptAgent({ target: "w3:p1" }, deps);
    expect(log.at(-1)).toBe("herdr.paneClose w3:p1");
  });

  it("when the new one never comes up: closes the NEW terminal and leaves the herdr pane", async () => {
    const { deps, log } = setup({ terminals: [coreTerminal({ status: null })] });
    const error = await adoptAgent({ target: "w3:p1" }, deps).catch((e) => e);
    expect(error.code).toBe("adopt_failed");
    expect(error.message).toContain("w3:p1 was left as it was");
    expect(log.at(-1)).toBe('app terminal.kill {"terminal":"t4c"}');
    expect(log.some((l) => l.startsWith("herdr.paneClose"))).toBe(false);
  });

  it("when the new program exits at once: same - old pane kept", async () => {
    const { deps, log } = setup({ terminals: [coreTerminal({ state: "finished" })] });
    expect((await adoptAgent({ target: "w3:p1" }, deps).catch((e) => e)).code).toBe("adopt_failed");
    expect(log.some((l) => l.startsWith("herdr.paneClose"))).toBe(false);
  });

  it("when the app names no terminal: fails before waiting, old pane kept", async () => {
    const { deps, log } = setup({ reply: { ok: true } });
    expect((await adoptAgent({ target: "w3:p1" }, deps).catch((e) => e)).code).toBe("adopt_failed");
    expect(log.some((l) => l.startsWith("herdr.paneClose"))).toBe(false);
  });

  it("when the old agent starts working mid-adopt: kills the new one, keeps the old", async () => {
    const { deps, log } = setup({ statuses: ["idle", "working"] });
    const error = await adoptAgent({ target: "w3:p1" }, deps).catch((e) => e);
    expect(error.code).toBe("agent_busy");
    expect(log.at(-1)).toBe('app terminal.kill {"terminal":"t4c"}');
    expect(log.some((l) => l.startsWith("herdr.paneClose"))).toBe(false);
  });

  it("reports a forked session id honestly", async () => {
    const other = "11111111-1111-1111-1111-111111111111";
    const { deps } = setup({ sessions: [other] });
    const result = await adoptAgent({ target: "w3:p1" }, deps);
    expect(result.resumedSessionId).toBe(other);
    expect(result.hint).toContain("forked");
  });

  // --- regressions from the adversarial review ---------------------------------

  it("re-check shows a different session (a /clear) that is working: old pane kept, new one closed", async () => {
    const { deps, log } = setup({ recheck: { status: "working", sessionId: "99999999-9999-9999-9999-999999999999" } });
    const error = await adoptAgent({ target: "w3:p1" }, deps).catch((e) => e);
    expect(error.code).toBe("agent_busy");
    expect(error.message).toContain("now runs something else");
    expect(log.some((l) => l.startsWith("herdr.paneClose"))).toBe(false);
    expect(log.at(-1)).toBe('app terminal.kill {"terminal":"t4c"}');
  });

  it("re-check can't reach herdr: old pane kept, new one closed", async () => {
    const { deps, log } = setup({ recheck: new HerdrError("timeout", "herdr slow") });
    const error = await adoptAgent({ target: "w3:p1" }, deps).catch((e) => e);
    expect(error.message).toContain("could not be checked again");
    expect(log.some((l) => l.startsWith("herdr.paneClose"))).toBe(false);
  });

  it("closing the old pane fails: the new one is closed too, never two live copies", async () => {
    const { deps, log } = setup({ paneCloseError: new HerdrError("pane_close_failed", "nope") });
    const error = await adoptAgent({ target: "w3:p1" }, deps).catch((e) => e);
    expect(error.code).toBe("adopt_failed");
    expect(error.message).toContain("t4c");
    expect(log.at(-1)).toBe('app terminal.kill {"terminal":"t4c"}');
  });

  it("says so when closing the new terminal itself fails", async () => {
    const { deps } = setup({ terminals: [coreTerminal({ status: null })], killError: new CoreError("app_error", "window busy") });
    const error = await adoptAgent({ target: "w3:p1" }, deps).catch((e) => e);
    expect(error.message).toContain("could NOT be closed");
    expect(error.message).not.toContain("t4c was closed");
  });

  it("finds the terminal through the tab when the reply names only the tab", async () => {
    const { deps, log } = setup({
      reply: { space: "sp1", tab: "tb7" },
      spaces: [{ id: "sp1", name: "x", folder: null, machine: null, active: true, tabs: [{ id: "tb7", name: "1", active: true, terminals: [{ terminal: "t4c", pane: "p", status: null, app: null, name: null }] }] }],
    });
    expect((await adoptAgent({ target: "w3:p1" }, deps)).to.terminal).toBe("t4c");
    expect(log.at(-1)).toBe("herdr.paneClose w3:p1");
  });

  it("a programming fault while waiting still closes the new terminal", async () => {
    const { deps, log } = setup();
    deps.sessions = async () => {
      throw new TypeError("bug");
    };
    expect((await adoptAgent({ target: "w3:p1" }, deps).catch((e) => e)).code).toBe("adopt_failed");
    expect(log.at(-1)).toBe('app terminal.kill {"terminal":"t4c"}');
  });
});
