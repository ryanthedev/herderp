// stdio MCP server entry point for the herderp plugin.
//
// IMPORTANT: stdout is the JSON-RPC channel once the transport connects.
// Never `console.log` here (or anywhere reachable from a handler) - all
// diagnostics go to stderr via `console.error`. See registry.ts for how
// tool-handler errors stay off stdout too.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTool } from "./registry.js";
import { createHerdrClient } from "./herdr/client.js";
import { createHostRegistry } from "./herdr/hosts.js";
import { registerHostTools } from "./tools/hosts.js";
import { createNecromancy } from "./necromancy/core.js";
import { registerCuratedTools } from "./tools/curated.js";
import { registerNecromancyTools } from "./tools/necromancy.js";
import { createCoreClient, type CoreClient } from "./core/client.js";
import { createSessionLookup } from "./core/sessions.js";
import { createCoreView } from "./core/view.js";

export const SERVER_NAME = "derp";
export const SERVER_VERSION = "0.14.0";

/** Builds a bare McpServer with no tools registered - reusable by the real entry point and by tests. */
export function createServer(): McpServer {
  return new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
}

/** Registers the Phase 1 stub tool that proves the registerTool pipe end to end. */
function registerStubTool(server: McpServer): void {
  registerTool(server, {
    name: "herderp_ping",
    description: "Stub tool proving the herderp MCP stdio pipe is wired; echoes back the current timestamp.",
    inputSchema: {},
    handler: () => ({ ok: true, timestamp: new Date().toISOString() }),
  });
}

/**
 * The space this server's agent runs in. The MCP server inherits its agent's
 * environment, and neither id changes for a running terminal, so reading it
 * here is safe: herdr's HERDR_WORKSPACE_ID, else the `herdr.space` label on
 * the herdr-core terminal named by HC_TERMINAL_ID.
 */
export async function currentWorkspace(core: CoreClient, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  if (env.HERDR_WORKSPACE_ID) return env.HERDR_WORKSPACE_ID;
  if (!env.HC_TERMINAL_ID) return undefined;
  try {
    return (await core.terminalGet(env.HC_TERMINAL_ID)).spaceId ?? undefined;
  } catch {
    return undefined; // the core is down: resolve as if no current space was given
  }
}

async function main(): Promise<void> {
  const server = createServer();
  registerStubTool(server);
  const client = createHerdrClient();
  const hosts = createHostRegistry({ localClient: client });
  // herdr-core runs the Herdr desktop app's terminals; herdr and it run side
  // by side, and every tool below reaches both.
  const core = createCoreClient();
  const sessions = createSessionLookup();
  registerCuratedTools(server, hosts, { core, sessions, env: process.env });
  registerHostTools(server, hosts);
  // Necromancy reads session files from THIS machine's disk, so it stays
  // bound to the local engines; remote hosts are a curated-tools concern.
  registerNecromancyTools(server, createNecromancy({ client, liveViews: [createCoreView(core, sessions)] }), {
    currentWorkspace: () => currentWorkspace(core, process.env),
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[herderp] MCP server listening on stdio (v${SERVER_VERSION})`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error("[herderp] MCP server failed to start:", error);
    process.exit(1);
  });
}
