// command.ts: builds the exact shell command herdr_agent{action:"watch"}
// hands back for Claude Code's Monitor tool. An MCP tool cannot push
// notifications into a conversation, but Monitor turns each stdout line of a
// long-running command into one - so the tool's job is to resolve the
// targets now (a typo fails here, not after arming) and return a command
// that runs this plugin's own cli.ts, wherever the plugin is installed.

import { join } from "node:path";
import type { HerdrClient } from "../herdr/client.js";
import { shellQuote } from "../herdr/hosts.js";
import type { AgentStatus } from "../herdr/types.js";
import type { CoreClient } from "../core/client.js";
import type { Engine } from "../bridge/route.js";

/** Monitor's ceiling for one arm; the watcher outlives nothing beyond it. */
export const MONITOR_MAX_TIMEOUT_MS = 1_800_000;

/** The CLI this module's command runs - resolved next to this file, so it is
 * right for the dev checkout and every installed plugin version alike. */
export const WATCH_CLI_PATH = join(import.meta.dir, "cli.ts");

export interface WatchCommandOptions {
  targets: string[];
  stallMs?: number;
  once?: boolean;
  json?: boolean;
  verbose?: boolean;
}

/** `bun run '<cli>' 'lead' 'cap' --stall 600000 --once`, every token quoted. */
export function buildWatchCommand(options: WatchCommandOptions, cliPath: string = WATCH_CLI_PATH): string {
  const argv = ["bun", "run", cliPath, ...options.targets];
  if (options.stallMs !== undefined) argv.push("--stall", String(options.stallMs));
  if (options.once) argv.push("--once");
  if (options.json) argv.push("--json");
  if (options.verbose) argv.push("--verbose");
  return argv.map(shellQuote).join(" ");
}

const WATCH_HINT =
  "Pass command, description, and timeout_ms to the Monitor tool. Each line it prints is one notification: " +
  "an agent stopping (done/idle/blocked/error, with its last message), stalling, or going away. Monitor ends the " +
  "watch after 30 minutes - re-arm with the same command if you still need it. A target already stopped " +
  "shows as 'currently done' on the first line; no further event comes for it until it works again. " +
  "Herdr app note: hc already tells a parent agent about its own children (sub-agents) - watch is for the rest.";

export interface WatchPlan {
  command: string;
  description: string;
  timeout_ms: number;
  targets: Array<{ target: string; paneId: string; status: AgentStatus }>;
  hint: string;
}

/**
 * Resolve every target through herdr (throws HerdrError, e.g.
 * agent_not_found, for one that doesn't exist) and return what to pass to
 * Monitor.
 */
export async function planWatch(client: HerdrClient, options: WatchCommandOptions): Promise<WatchPlan> {
  const targets = [];
  for (const target of options.targets) {
    const agent = await client.agentGet(target);
    targets.push({ target, paneId: agent.paneId, status: agent.status });
  }
  const names = options.targets.join(", ");
  return {
    command: buildWatchCommand(options),
    description: `herdr agents: ${names}`,
    timeout_ms: MONITOR_MAX_TIMEOUT_MS,
    targets,
    hint: WATCH_HINT,
  };
}

/**
 * planWatch across both engines. Targets arrive already resolved to one
 * engine each (bridge/resolve.ts); each is looked up once more here so the
 * plan shows its current status, and handed to the CLI as `core:<address>`
 * or `herdr:<target>` so it can't be misread later.
 */
export async function planBridgedWatch(
  clients: { herdr?: HerdrClient; core: CoreClient },
  resolved: Array<{ engine: Engine; target: string }>,
  options: Omit<WatchCommandOptions, "targets">,
): Promise<Omit<WatchPlan, "targets"> & { targets: Array<{ target: string; engine: Engine; paneId: string; status: string }> }> {
  const targets: Array<{ target: string; engine: Engine; paneId: string; status: string }> = [];
  const tokens: string[] = [];
  for (const r of resolved) {
    if (r.engine === "core") {
      const terminal = await clients.core.terminalGet(r.target);
      targets.push({ target: r.target, engine: "core", paneId: terminal.address, status: terminal.status ?? "unknown" });
      tokens.push(`core:${terminal.address}`);
    } else {
      const agent = await clients.herdr!.agentGet(r.target);
      targets.push({ target: r.target, engine: "herdr", paneId: agent.paneId, status: agent.status });
      tokens.push(`herdr:${r.target}`);
    }
  }
  const plan = await planWatchFromTokens(tokens, options);
  return { ...plan, targets };
}

function planWatchFromTokens(tokens: string[], options: Omit<WatchCommandOptions, "targets">): Omit<WatchPlan, "targets"> {
  const names = tokens.map((t) => t.replace(/^(core|herdr):/, "")).join(", ");
  return {
    command: buildWatchCommand({ ...options, targets: tokens }),
    description: `agents: ${names}`,
    timeout_ms: MONITOR_MAX_TIMEOUT_MS,
    hint: WATCH_HINT,
  };
}
