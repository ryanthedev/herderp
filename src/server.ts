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

export const SERVER_NAME = "derp";
export const SERVER_VERSION = "0.12.0";

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

async function main(): Promise<void> {
  const server = createServer();
  registerStubTool(server);
  const client = createHerdrClient();
  const hosts = createHostRegistry({ localClient: client });
  registerCuratedTools(server, hosts);
  registerHostTools(server, hosts);
  // Necromancy reads session files from THIS machine's disk, so it stays
  // bound to the local client; remote hosts are a curated-tools concern.
  registerNecromancyTools(server, createNecromancy({ client }));

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
