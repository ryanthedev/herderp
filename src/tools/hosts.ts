// herdr_host: the MCP face of the host registry (src/herdr/hosts.ts).
//
// One resource-oriented tool with an `action` discriminator, matching the
// curated tools' shape. Handlers are thin dispatch into the registry; every
// validation (name grammar, entry shape, unknown host) lives there and is
// unit-tested there. The registry file is the single source of truth - this
// tool is only a convenience over editing it by hand.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTool } from "../registry.js";
import type { HostRegistry } from "../herdr/hosts.js";

function need<T>(value: T | undefined, field: string, action: string): T {
  if (value === undefined || value === "") {
    throw new Error(`herdr_host{action:"${action}"} requires "${field}"`);
  }
  return value;
}

/** Registers the `herdr_host` tool on `server`, backed by `hosts`. */
export function registerHostTools(server: McpServer, hosts: HostRegistry): void {
  registerTool(server, {
    name: "herdr_host",
    description:
      "Named remote machines running herdr, reachable over ssh. Every herdr_* tool takes an optional " +
      "`host` naming one of these; omit it for this machine. Each call runs the REMOTE machine's own " +
      "herdr binary over ssh (BatchMode, so it never prompts - ssh keys or Tailscale SSH must already work), " +
      "so the local and remote herdr versions need not match. Actions:\n" +
      "- list: every registered host and the registry file path.\n" +
      "- add: register or replace a host (name, ssh; optional user, herdr, socket). ssh is the destination " +
      "as ssh takes it (hostname, IP, or user@host). user is passed as `-l` - use it for account names " +
      "containing '@'. herdr is the remote binary path when it is not on ssh's non-interactive PATH " +
      "(~/.local/bin and /opt/homebrew/bin are searched by default). socket selects a non-default remote " +
      "server session via HERDR_SOCKET_PATH.\n" +
      "- remove: forget a host (name).\n" +
      "- check: ssh in and prove herdr answers - returns its version and server sessions (name). " +
      "Run this once after add.\n" +
      "The necromancy_* tools read THIS machine's session files and do not take a host.",
    inputSchema: {
      action: z.enum(["list", "add", "remove", "check"]),
      name: z.string().optional(),
      ssh: z.string().optional(),
      user: z.string().optional(),
      herdr: z.string().optional(),
      socket: z.string().optional(),
    },
    handler: async (args) => {
      switch (args.action) {
        case "list":
          return {
            hosts: await hosts.list(),
            path: hosts.path,
            hint: "use one with host:'<name>' on any herdr_* tool; herdr_host{action:'check',name} to verify it answers",
          };
        case "add": {
          const record = await hosts.add(need(args.name, "name", "add"), {
            ssh: need(args.ssh, "ssh", "add"),
            user: args.user,
            herdr: args.herdr,
            socket: args.socket,
          });
          return {
            ok: true,
            host: record,
            hint: `saved to ${hosts.path}; herdr_host{action:'check',name:"${record.name}"} to verify it answers`,
          };
        }
        case "remove":
          await hosts.remove(need(args.name, "name", "remove"));
          return { ok: true, hint: "removed" };
        case "check": {
          const check = await hosts.check(need(args.name, "name", "check"));
          return {
            ok: true,
            ...check,
            hint: `reachable; herdr_agent{action:'list',host:"${check.name}"} to see its agents`,
          };
        }
      }
    },
  });
}
