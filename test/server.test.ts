// Integration test: spawns the real server via `bun run src/server.ts` and
// speaks real MCP JSON-RPC to it through the SDK's own client transport.
// This is the strongest available proof of DW-1.1 ("starts over stdio and
// answers initialize + tools/list without error") and DW-1.3 ("stub tool
// appears in tools/list and returns on call") without a live Claude Code host.

import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER_ENTRY = path.join(import.meta.dir, "..", "src", "server.ts");

async function connectClient() {
  const transport = new StdioClientTransport({
    command: "bun",
    args: ["run", SERVER_ENTRY],
  });
  const client = new Client({ name: "herderp-test-client", version: "0.0.0" });
  await client.connect(transport);
  return { client, transport };
}

describe("herderp MCP server (stdio)", () => {
  it("DW_1_1_boots_over_stdio_and_answers_initialize_and_tools_list", async () => {
    const { client, transport } = await connectClient();
    try {
      // connect() already performs `initialize` under the hood; getServerVersion
      // is only populated once that handshake succeeded without error.
      expect(client.getServerVersion()?.name).toBe("derp");

      const { tools } = await client.listTools();
      expect(Array.isArray(tools)).toBe(true);
    } finally {
      await transport.close();
    }
  });

  it("DW_1_3_stub_tool_appears_in_tools_list_and_returns_on_call", async () => {
    const { client, transport } = await connectClient();
    try {
      const { tools } = await client.listTools();
      const stub = tools.find((t) => t.name === "herderp_ping");
      expect(stub).toBeDefined();
      expect(stub?.description).toContain("Stub tool");

      const result = await client.callTool({ name: "herderp_ping", arguments: {} });
      expect(result.isError).toBeFalsy();
      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0]!.text);
      expect(parsed.ok).toBe(true);
      expect(typeof parsed.timestamp).toBe("string");
    } finally {
      await transport.close();
    }
  });

  it("DW_2_3_curated_herdr_tools_appear_in_the_real_servers_tools_list", async () => {
    const { client, transport } = await connectClient();
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);

      for (const expected of [
        "herdr_agent_list",
        "herdr_agent_get",
        "herdr_agent_read",
        "herdr_agent_wait",
        "herdr_workspace_create",
        "herdr_workspace_focus",
        "herdr_pane_run",
        "herdr_pane_close",
        "herdr_session_list",
      ]) {
        expect(names).toContain(expected);
      }
    } finally {
      await transport.close();
    }
  });

  it("DW_3_6_necromancy_tools_appear_in_the_real_servers_tools_list", async () => {
    const { client, transport } = await connectClient();
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);

      for (const expected of ["necromancy_find_spaces", "necromancy_list_sessions"]) {
        expect(names).toContain(expected);
      }
    } finally {
      await transport.close();
    }
  });

  it("DW_1_1_stdout_carries_only_json_rpc_no_stray_logging", async () => {
    // Capture the child's raw stdout independently of the SDK's own framing
    // and assert every non-empty line parses as a JSON-RPC message. A stray
    // `console.log` anywhere in the server or a tool handler would show up
    // here as a non-JSON line.
    const child = spawn("bun", ["run", SERVER_ENTRY], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    // Send a raw initialize request over stdin to prompt at least one reply.
    const initRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "raw-stdout-check", version: "0.0.0" },
      },
    };
    child.stdin.write(`${JSON.stringify(initRequest)}\n`);

    await new Promise((resolve) => setTimeout(resolve, 500));
    child.kill();

    const lines = stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});
