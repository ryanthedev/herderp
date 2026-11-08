// Tests for engine routing (src/bridge/route.ts) and target resolution
// (src/bridge/resolve.ts).

import { describe, expect, it } from "bun:test";
import { engineOfId, homeEngine, pickEngine, qualifyCore } from "../../src/bridge/route.js";
import { resolveAgentTarget } from "../../src/bridge/resolve.js";
import type { CoreClient } from "../../src/core/client.js";
import { CoreError } from "../../src/core/types.js";
import type { HerdrClient } from "../../src/herdr/client.js";
import { HerdrError } from "../../src/herdr/types.js";

const SPACE = `sp${"a".repeat(32)}`;
const PANE = `p${"0".repeat(32)}`;

describe("engineOfId", () => {
  it("decides herdr pane/tab/terminal ids and core qualified addresses for agents", () => {
    expect(engineOfId("w8:pG")).toBe("herdr");
    expect(engineOfId("w8:tD")).toBe("herdr");
    expect(engineOfId("term_65f05a922b1be7a")).toBe("herdr");
    expect(engineOfId("ska/t3s")).toBe("core");
  });

  it("leaves bare words to resolution - including names that start with w or look like core addresses", () => {
    // Regression: `wprobe3` was routed to herdr as a workspace id.
    for (const name of ["wprobe3", "web", "w8", "t3s", "review", "cmd-qa"]) expect(engineOfId(name)).toBeNull();
  });

  it("uses full layout shapes for layout ids", () => {
    expect(engineOfId(SPACE, "layout")).toBe("core");
    expect(engineOfId(`tb${"f".repeat(32)}`, "layout")).toBe("core");
    expect(engineOfId(PANE, "layout")).toBe("core");
    expect(engineOfId(`ska/${SPACE}`, "layout")).toBe("core");
    expect(engineOfId("w8", "layout")).toBe("herdr");
    expect(engineOfId("w8:pG", "layout")).toBe("herdr");
    expect(engineOfId("sp123", "layout")).toBeNull();
  });
});

describe("homeEngine / pickEngine", () => {
  it("follows the caller's own terminal", () => {
    expect(homeEngine({ HC_TERMINAL_ID: "t3" })).toBe("core");
    expect(homeEngine({ HERDR_WORKSPACE_ID: "w1" })).toBe("herdr");
    expect(homeEngine({ HC_TERMINAL_ID: "t3", HERDR_WORKSPACE_ID: "w1" })).toBe("core");
    expect(homeEngine({})).toBe("core");
  });

  it("explicit beats id shape beats home", () => {
    expect(pickEngine("herdr", [SPACE], { HC_TERMINAL_ID: "t1" })).toBe("herdr");
    expect(pickEngine(undefined, [undefined, "w3"], { HC_TERMINAL_ID: "t1" })).toBe("herdr");
    expect(pickEngine(undefined, [undefined, ""], { HERDR_WORKSPACE_ID: "w1" })).toBe("herdr");
  });

  it("qualifyCore prefixes a host, leaves local and qualified ids alone", () => {
    expect(qualifyCore("t7", "ska")).toBe("ska/t7");
    expect(qualifyCore("t7", "local")).toBe("t7");
    expect(qualifyCore("vana/t7", "ska")).toBe("vana/t7");
    expect(qualifyCore("t7", undefined)).toBe("t7");
  });
});

function deps(core: (t: string) => Promise<unknown>, herdr: (t: string) => Promise<unknown>) {
  const coreClient = { terminalGet: core } as unknown as CoreClient;
  const herdrClient = { agentGet: herdr } as unknown as HerdrClient;
  return { core: coreClient, herdr: { clientFor: async () => herdrClient } };
}
const coreMissing = async () => {
  throw new CoreError("not_found", "no terminal");
};
const herdrMissing = async () => {
  throw new HerdrError("agent_not_found", "not found");
};
const found = async () => ({});

describe("resolveAgentTarget", () => {
  it("takes a shape-decided target straight to its engine, qualifying core with host", async () => {
    const none = deps(coreMissing, herdrMissing);
    expect(await resolveAgentTarget("w8:pG", {}, none)).toEqual({ engine: "herdr", target: "w8:pG" });
    expect(await resolveAgentTarget("t3", { engine: "core", host: "ska" }, none)).toEqual({ engine: "core", target: "ska/t3" });
  });

  it("finds a bare name in whichever engine has it", async () => {
    expect(await resolveAgentTarget("review", {}, deps(found, herdrMissing))).toEqual({ engine: "core", target: "review" });
    expect(await resolveAgentTarget("review", {}, deps(coreMissing, found))).toEqual({ engine: "herdr", target: "review" });
  });

  it("refuses to guess when both engines have it", async () => {
    const error = await resolveAgentTarget("review", {}, deps(found, found)).catch((e) => e);
    expect(error.code).toBe("ambiguous_target");
    expect(error.message).toContain('engine:"core"');
  });

  it("says not found when neither has it, and unresolved when an engine couldn't be asked", async () => {
    expect((await resolveAgentTarget("x", {}, deps(coreMissing, herdrMissing)).catch((e) => e)).code).toBe("target_not_found");
    const down = async () => {
      throw new HerdrError("socket_unreachable", "herdr is down");
    };
    const error = await resolveAgentTarget("x", {}, deps(coreMissing, down)).catch((e) => e);
    expect(error.code).toBe("target_unresolved");
    expect(error.message).toContain("socket_unreachable");
  });

  it("a hit in the live engine wins over a down one", async () => {
    const down = async () => {
      throw new CoreError("core_unreachable", "down");
    };
    expect(await resolveAgentTarget("x", {}, deps(down, found))).toEqual({ engine: "herdr", target: "x" });
  });

  it("lets a programming fault through", async () => {
    const boom = async () => {
      throw new TypeError("bug");
    };
    expect(await resolveAgentTarget("x", {}, deps(boom, found)).catch((e) => e)).toBeInstanceOf(TypeError);
  });
});
