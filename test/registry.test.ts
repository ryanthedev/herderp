// Unit tests for the registerTool harness (src/registry.ts) against a bare
// McpServer - no stdio transport needed, since registerTool only touches the
// server's tool-registration bookkeeping.

import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTool } from "../src/registry.js";

function bareServer(): McpServer {
  return new McpServer({ name: "test-server", version: "0.0.0" });
}

describe("registerTool", () => {
  it("DW_1_3_registers_a_tool_visible_on_the_server_and_invokes_the_handler", async () => {
    const server = bareServer();
    let called = false;

    registerTool(server, {
      name: "echo",
      description: "Echoes the given value back.",
      inputSchema: { value: z.string() },
      handler: ({ value }) => {
        called = true;
        return { value };
      },
    });

    const registered = (server as unknown as { _registeredTools: Record<string, { handler: unknown }> })
      ._registeredTools;
    expect(Object.keys(registered)).toContain("echo");

    const tool = registered.echo!;
    const result = await (tool.handler as (args: unknown, extra: unknown) => Promise<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>)({ value: "hi" }, {});

    expect(called).toBe(true);
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0]!.text)).toEqual({ value: "hi" });
  });

  it("wraps a thrown handler error into an isError result and never rethrows", async () => {
    const server = bareServer();

    registerTool(server, {
      name: "boom",
      description: "Always throws.",
      inputSchema: {},
      handler: () => {
        throw new Error("kaboom");
      },
    });

    const registered = (server as unknown as { _registeredTools: Record<string, { handler: unknown }> })
      ._registeredTools;
    const tool = registered.boom!;

    const result = await (tool.handler as (args: unknown, extra: unknown) => Promise<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>)({}, {});

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe("kaboom");
  });

  it("accepts a plain string return value without JSON-wrapping it", async () => {
    const server = bareServer();

    registerTool(server, {
      name: "greet",
      description: "Returns a plain string.",
      inputSchema: {},
      handler: () => "hello",
    });

    const registered = (server as unknown as { _registeredTools: Record<string, { handler: unknown }> })
      ._registeredTools;
    const tool = registered.greet!;

    const result = await (tool.handler as (args: unknown, extra: unknown) => Promise<{
      content: Array<{ type: string; text: string }>;
    }>)({}, {});

    expect(result.content[0]!.text).toBe("hello");
  });
});
