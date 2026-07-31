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
    // An untyped Error has no code, so it renders exactly as before - no
    // empty `[] ` prefix.
    expect(result.content[0]!.text).toBe("kaboom");
  });

  it("leads a typed error's text with its code so callers can branch on it", async () => {
    const server = bareServer();
    class Typed extends Error {
      readonly code = "agent_not_found";
    }

    registerTool(server, {
      name: "typed_boom",
      description: "Throws an error carrying a code.",
      inputSchema: {},
      handler: () => {
        throw new Typed("agent target w9:p1 not found");
      },
    });

    const registered = (server as unknown as { _registeredTools: Record<string, { handler: unknown }> })
      ._registeredTools;
    const tool = registered.typed_boom!;

    const result = await (tool.handler as (args: unknown, extra: unknown) => Promise<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>)({}, {});

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe("[agent_not_found] agent target w9:p1 not found");
  });

  it("ignores a non-string code rather than rendering it", async () => {
    const server = bareServer();
    class Weird extends Error {
      readonly code = 42;
    }

    registerTool(server, {
      name: "weird_boom",
      description: "Throws an error whose code is not a string.",
      inputSchema: {},
      handler: () => {
        throw new Weird("something odd");
      },
    });

    const registered = (server as unknown as { _registeredTools: Record<string, { handler: unknown }> })
      ._registeredTools;
    const tool = registered.weird_boom!;

    const result = await (tool.handler as (args: unknown, extra: unknown) => Promise<{
      content: Array<{ type: string; text: string }>;
    }>)({}, {});

    expect(result.content[0]!.text).toBe("something odd");
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
