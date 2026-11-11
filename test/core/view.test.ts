// Tests for the Herdr app as necromancy sees it (src/core/view.ts), and for
// necromancy's live join and handle resolution across herdr + herdr-core.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CoreClient } from "../../src/core/client.js";
import { createCoreView } from "../../src/core/view.js";
import { CoreError, type AppSpace, type CoreTerminal } from "../../src/core/types.js";
import type { HerdrClient } from "../../src/herdr/client.js";
import { HerdrError, type Agent, type Pane, type Tab, type Workspace } from "../../src/herdr/types.js";
import { createNecromancy, deriveSlug } from "../../src/necromancy/core.js";

const CORE_SESSION = "33333333-3333-3333-3333-333333333333";
const HERDR_SESSION = "44444444-4444-4444-4444-444444444444";
const CWD = "/repo/api";

function terminal(over: Partial<CoreTerminal> = {}): CoreTerminal {
  return {
    address: "t7", name: null, state: "live", app: "claude-code", status: "done", blockedKind: null, message: "",
    title: "", turn: 1, cwd: CWD, foreground: { pid: 7, argv: ["claude"], cwd: CWD }, labels: {}, argv: [], createdMs: null, parent: null,
    spaceId: "sp1", tabId: "tb1", where: "api / 1", machine: null, ...over,
  };
}
const SPACES: AppSpace[] = [
  {
    id: "sp1", name: "api", folder: "/somewhere-else", machine: null, active: true,
    tabs: [
      { id: "tb1", name: "1", active: true, terminals: [{ terminal: "t7", pane: "pa", status: "done", app: "claude-code", name: null }] },
      { id: "tb2", name: "logs", active: false, terminals: [{ terminal: "t8", pane: "pb", status: null, app: null, name: null }] },
    ],
  },
];

function coreClient(down = false): CoreClient {
  const fail = async () => {
    throw new CoreError("core_unreachable", "no core");
  };
  return {
    appSpaces: down ? fail : async () => SPACES,
    terminalList: down
      ? fail
      : async () => ({
          terminals: [terminal(), terminal({ address: "t8", app: "", status: null, foreground: { pid: 8, argv: ["zsh"], cwd: CWD } }), terminal({ address: "t9", spaceId: null, tabId: null, parent: "t7" })],
          machines: [],
        }),
  } as unknown as CoreClient;
}
const sessions = async (t: CoreTerminal) => (t.address === "t7" ? CORE_SESSION : t.address === "t9" ? "55555555-5555-5555-5555-555555555555" : null);

describe("createCoreView", () => {
  it("presents spaces as workspaces, cwd from the first terminal's live folder", async () => {
    const view = createCoreView(coreClient(), sessions);
    expect(await view.workspaceList()).toEqual([{ id: "sp1", label: "api", cwd: CWD, tabCount: 2, paneCount: 2 }]);
    expect((await view.tabList("sp1")).map((t) => [t.label, t.number])).toEqual([["1", 1], ["logs", 2]]);
  });

  it("marks Claude panes with their session and shells as plain", async () => {
    const panes = await createCoreView(coreClient(), sessions).paneList("sp1");
    expect(panes.map((p) => [p.id, p.agent, p.sessionId])).toEqual([["pa", "claude", CORE_SESSION], ["pb", "", ""]]);
  });

  it("lists live Claude agents, a pane-less sub-agent by its address", async () => {
    const agents = await createCoreView(coreClient(), sessions).agentList();
    expect(agents.map((a) => [a.paneId, a.sessionId])).toEqual([["pa", CORE_SESSION], ["t9", "55555555-5555-5555-5555-555555555555"]]);
  });
});

// --- necromancy across engines -------------------------------------------------

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "herderp-view-"));
  const dir = join(root, deriveSlug(CWD));
  await mkdir(dir, { recursive: true });
  const line = (text: string) => JSON.stringify({ type: "user", cwd: CWD, message: { role: "user", content: text } });
  await writeFile(join(dir, `${CORE_SESSION}.jsonl`), `${line("core work")}\n`);
  await writeFile(join(dir, `${HERDR_SESSION}.jsonl`), `${line("herdr work")}\n`);
});
afterAll(() => rm(root, { recursive: true, force: true }));

function herdrClient(opts: { down?: boolean; claudeInTab1?: boolean } = {}): HerdrClient {
  const fail = async () => {
    throw new HerdrError("socket_unreachable", "no herdr");
  };
  const agent: Agent = { agent: "claude", sessionId: HERDR_SESSION, status: "idle", cwd: CWD, workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" };
  const ws: Workspace = { id: "w1", label: "api", cwd: CWD, tabCount: 1, paneCount: 1 };
  const tab: Tab = { id: "w1:t1", workspaceId: "w1", label: "1", number: 4, focused: false };
  const pane: Pane = { id: "w1:p1", workspaceId: "w1", tabId: "w1:t1", agent: opts.claudeInTab1 === false ? "" : "claude", sessionId: opts.claudeInTab1 === false ? "" : HERDR_SESSION, cwd: CWD, status: "idle" };
  return (opts.down
    ? { agentList: fail, workspaceList: fail, tabList: fail, paneList: fail }
    : { agentList: async () => [agent], workspaceList: async () => [ws], tabList: async () => [tab], paneList: async () => [pane] }) as unknown as HerdrClient;
}

describe("necromancy with both engines", () => {
  it("marks sessions live in either engine and gives each its handle", async () => {
    const necro = createNecromancy({ client: herdrClient(), liveViews: [createCoreView(coreClient(), sessions)], projectsRoot: root });
    const { sessions: list, degraded } = await necro.listSessions(CWD);
    expect(degraded).toBe(false);
    expect(Object.fromEntries(list.map((s) => [s.sessionId, [s.live, s.handle]]))).toEqual({
      [CORE_SESSION]: [true, "api:1"],
      [HERDR_SESSION]: [true, "api:1"],
    });
  });

  it("degrades, keeping the other engine's live flags, when one is down", async () => {
    const necro = createNecromancy({ client: herdrClient({ down: true }), liveViews: [createCoreView(coreClient(), sessions)], projectsRoot: root });
    const { sessions: list, degraded } = await necro.listSessions(CWD);
    expect(degraded).toBe(true);
    expect(list.find((s) => s.sessionId === CORE_SESSION)?.live).toBe(true);
    expect(list.find((s) => s.sessionId === HERDR_SESSION)?.live).toBe(false);
  });

  it("a name in both engines is ambiguous when both tabs hold a live Claude", async () => {
    const necro = createNecromancy({ client: herdrClient(), liveViews: [createCoreView(coreClient(), sessions)], projectsRoot: root });
    const result = await necro.resolveHandle({ handle: "api:1" });
    expect(result.status).toBe("ambiguous_workspace");
    expect(result.status === "ambiguous_workspace" && result.candidates.map((c) => c.engine)).toEqual(["herdr", "core"]);
  });

  it("...and resolves to the one engine whose tab holds a live Claude", async () => {
    const necro = createNecromancy({ client: herdrClient({ claudeInTab1: false }), liveViews: [createCoreView(coreClient(), sessions)], projectsRoot: root });
    expect(await necro.resolveHandle({ handle: "api:1" })).toMatchObject({ status: "resolved", engine: "core", sessionId: CORE_SESSION });
  });

  it("resolves `:logs` against a current Herdr app space", async () => {
    const necro = createNecromancy({ client: herdrClient(), liveViews: [createCoreView(coreClient(), sessions)], projectsRoot: root });
    expect(await necro.resolveHandle({ handle: ":1", workspaceId: "sp1" })).toMatchObject({ status: "resolved", engine: "core" });
  });

  it("is loud only when every engine is down", async () => {
    const necro = createNecromancy({ client: herdrClient({ down: true }), liveViews: [createCoreView(coreClient(true), sessions)], projectsRoot: root });
    expect(await necro.resolveHandle({ handle: "api:1" }).catch((e) => e)).toBeInstanceOf(HerdrError);
    const oneUp = createNecromancy({ client: herdrClient({ down: true }), liveViews: [createCoreView(coreClient(), sessions)], projectsRoot: root });
    expect(await oneUp.resolveHandle({ handle: "api:1" })).toMatchObject({ status: "resolved", engine: "core" });
  });

  it("an engine that isn't installed is not 'degraded'", async () => {
    const notInstalled = async () => {
      throw new CoreError("not_installed", "no hc here");
    };
    const absentCore = { appSpaces: notInstalled, terminalList: notInstalled } as unknown as CoreClient;
    const necro = createNecromancy({ client: herdrClient(), liveViews: [createCoreView(absentCore, sessions)], projectsRoot: root });
    expect((await necro.listSessions(CWD)).degraded).toBe(false);
    expect((await necro.findSpaces()).degraded).toBe(false);
  });

  it("an installed engine that is down is degraded, and named", async () => {
    const necro = createNecromancy({ client: herdrClient(), liveViews: [createCoreView(coreClient(true), sessions)], projectsRoot: root });
    expect(await necro.listSessions(CWD)).toMatchObject({ degraded: true, degradedEngines: ["core"] });
  });

  it("a miss while an engine is down says so", async () => {
    const necro = createNecromancy({ client: herdrClient({ down: true }), liveViews: [createCoreView(coreClient(), sessions)], projectsRoot: root });
    const result = await necro.resolveHandle({ handle: "nowhere:1" });
    expect(result).toMatchObject({ status: "not_found", degradedEngines: ["herdr"] });
    expect(result.status === "not_found" && result.detail).toContain("herdr did not answer");
  });

  it("one engine failing mid-resolve doesn't sink the other's answer", async () => {
    const half = herdrClient({ claudeInTab1: true });
    const slow = async () => {
      throw new HerdrError("timeout", "herdr slow");
    };
    const flaky = { ...half, tabList: slow, paneList: slow } as unknown as HerdrClient;
    const necro = createNecromancy({ client: flaky, liveViews: [createCoreView(coreClient(), sessions)], projectsRoot: root });
    expect(await necro.resolveHandle({ handle: "api:1" })).toMatchObject({ status: "resolved", engine: "core" });
  });
});
