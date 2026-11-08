// resolve.ts: turn an agent target into exactly one engine, never a guess.
//
// A target whose shape decides its engine (route.ts) goes straight there. A
// bare word - `review`, or `t3s`, which is a core address but also a legal
// herdr agent name - is looked up in both engines at once:
//   - found in one: that one;
//   - found in both: `ambiguous_target`, naming both, so the caller retries
//     with `engine` (or a qualified id) instead of driving the wrong agent;
//   - found in neither: `target_not_found`, with each engine's own answer.
// An engine that couldn't be asked might hold the real agent, so a hit in the
// other one is used only for reading (get/read/wait/watch); anything that
// changes an agent is refused with `target_unresolved` until `engine` names
// one. A finished core terminal counts as a weak hit: it loses to a live
// herdr agent, but still answers when nothing else does (its output can be
// read after it ends).

import type { CoreClient } from "../core/client.js";
import { CoreError } from "../core/types.js";
import type { ClientResolver } from "../herdr/hosts.js";
import { HerdrError } from "../herdr/types.js";
import { engineOfId, qualifyCore, type Engine } from "./route.js";
import { isNotInstalled } from "./absent.js";

/** Codes that mean "asked, and it isn't there" - anything else means "couldn't ask". */
const NOT_FOUND_CODES: ReadonlySet<string> = new Set(["not_found", "agent_not_found", "pane_not_found", "unknown_host", "machine_unknown"]);

export class BridgeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
  }
}

export interface ResolvedTarget {
  engine: Engine;
  /** The id to hand that engine: a core target is machine-qualified when `host` named one. */
  target: string;
}

type Probe = { found: true; live: boolean } | { found: false; missing: boolean; detail: string };

async function probe(run: () => Promise<{ live: boolean }>): Promise<Probe> {
  try {
    const { live } = await run();
    return { found: true, live };
  } catch (error) {
    if (error instanceof HerdrError || error instanceof CoreError) {
      // Not installed here is as good as "asked, not there": that engine can't hold it.
      return { found: false, missing: NOT_FOUND_CODES.has(error.code) || isNotInstalled(error), detail: `[${error.code}] ${error.message}` };
    }
    throw error; // a programming fault stays loud
  }
}

export interface ResolveDeps {
  herdr: ClientResolver;
  core: CoreClient;
}

export async function resolveAgentTarget(
  target: string,
  opts: { engine?: Engine; host?: string; mutating?: boolean },
  deps: ResolveDeps,
): Promise<ResolvedTarget> {
  const engine = opts.engine ?? engineOfId(target);
  if (engine === "core") return { engine, target: qualifyCore(target, opts.host) };
  if (engine === "herdr") return { engine, target };

  const coreTarget = qualifyCore(target, opts.host);
  const [core, herdr] = await Promise.all([
    probe(async () => ({ live: (await deps.core.terminalGet(coreTarget)).state === "live" })),
    probe(async () => {
      await (await deps.herdr.clientFor(opts.host)).agentGet(target);
      return { live: true };
    }),
  ]);
  if (core.found && !core.live && herdr.found) return { engine: "herdr", target };
  if (core.found && herdr.found) {
    throw new BridgeError(
      "ambiguous_target",
      `"${target}" names an agent in both engines - pass engine:"core" (Herdr app terminal ${coreTarget}) or engine:"herdr" (herdr agent ${target})`,
    );
  }
  const unasked = (p: Probe) => !p.found && !p.missing;
  if ((core.found && unasked(herdr)) || (herdr.found && unasked(core))) {
    const down = core.found ? herdr : core;
    if (opts.mutating) {
      throw new BridgeError(
        "target_unresolved",
        `"${target}" was found in ${core.found ? "the Herdr app (core)" : "herdr"}, but ${core.found ? "herdr" : "the Herdr app (core)"} could not be asked (${down.found ? "" : down.detail}) and may hold an agent of the same name - pass engine to act on it`,
      );
    }
  }
  if (core.found) return { engine: "core", target: coreTarget };
  if (herdr.found) return { engine: "herdr", target };
  const coreDetail = core.found ? "" : core.detail;
  const herdrDetail = herdr.found ? "" : herdr.detail;
  const anyUnreachable = (!core.found && !core.missing) || (!herdr.found && !herdr.missing);
  throw new BridgeError(
    anyUnreachable ? "target_unresolved" : "target_not_found",
    `no agent "${target}" - Herdr app (core): ${coreDetail}; herdr: ${herdrDetail}`,
  );
}
