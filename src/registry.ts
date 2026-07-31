// registerTool: a deep harness over McpServer.registerTool.
//
// Hides from every caller (Phases 2-3 register ~12 tools through this):
//   - the SDK's CallToolResult content-array shape (handlers just return plain
//     data or a string; this wraps it)
//   - error normalization (a thrown error becomes an `isError` tool result,
//     never an uncaught exception, never a stdout write)
//   - stderr-only logging of handler failures, keeping the stdio JSON-RPC
//     channel (stdout) clean
//
// See discovery doc for the design-it-twice comparison behind this shape:
// .code-foundations/build/2026-07-09-herderp-plugin-necromancy-phase-1-discovery.md

import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";

/** A raw zod shape, e.g. `{ foo: z.string() }` - what McpServer.registerTool expects for inputSchema. */
export type ToolInputShape = Record<string, z.ZodTypeAny>;

/** Parsed args matching a given input shape. */
export type ToolArgs<Shape extends ToolInputShape> = {
  [K in keyof Shape]: z.infer<Shape[K]>;
};

/** What a tool handler may return: plain JSON-serializable data, or a preformatted string. */
export type ToolResult = Record<string, unknown> | string;

export type ToolHandler<Shape extends ToolInputShape> = (
  args: ToolArgs<Shape>,
) => Promise<ToolResult> | ToolResult;

export interface ToolDefinition<Shape extends ToolInputShape = ToolInputShape> {
  name: string;
  description: string;
  inputSchema: Shape;
  handler: ToolHandler<Shape>;
}

/**
 * Registers a tool on `server`, hiding MCP response-shape and error-handling
 * conventions from the caller. The common case for a handler is:
 *
 *   registerTool(server, {
 *     name: "thing_get",
 *     description: "...",
 *     inputSchema: { id: z.string() },
 *     handler: async ({ id }) => ({ id, value: 42 }),
 *   });
 *
 * A thrown error in `handler` is caught, logged to stderr (never stdout), and
 * surfaced to the MCP client as `{ isError: true }` rather than crashing the
 * process or leaking onto the JSON-RPC stdout stream.
 */
export function registerTool<Shape extends ToolInputShape>(
  server: McpServer,
  definition: ToolDefinition<Shape>,
): void {
  const { name, description, inputSchema, handler } = definition;

  // Cast at the SDK boundary: `Shape extends ToolInputShape` is generic here,
  // so TS can't resolve the SDK's `Args extends ZodRawShapeCompat ? ... : ...`
  // conditional against it. Our own `ToolDefinition<Shape>` already guarantees
  // `inputSchema`/`handler` are shape-consistent, so this cast is safe.
  const wrapped = (async (args: ToolArgs<Shape>) => {
    try {
      const result = await handler(args);
      return { content: [{ type: "text" as const, text: toText(result) }] };
    } catch (error) {
      console.error(`[herderp] tool "${name}" failed:`, error);
      return {
        content: [{ type: "text" as const, text: errorText(error) }],
        isError: true,
      };
    }
  }) as unknown as ToolCallback<Shape>;

  server.registerTool(name, { description, inputSchema }, wrapped);
}

function toText(result: ToolResult): string {
  return typeof result === "string" ? result : JSON.stringify(result);
}

/**
 * Renders a thrown error for the MCP client, leading with its `code` when it
 * has one: `[agent_not_found] agent target w9:p1 not found`.
 *
 * The code is the actionable half. `agent_not_found` tells a caller to fix
 * the target and retry; `command_failed` tells it the message is all there
 * is; `wait_timeout` tells it to wait longer rather than re-issue. Rendering
 * the message alone threw that away at the tool boundary - HerdrClient did
 * the work of recovering herdr's own codes and nothing downstream could see
 * them.
 *
 * Read structurally rather than via `instanceof`: both HerdrError and
 * NecromancyError carry a string `code`, and registry.ts is shared
 * infrastructure that must not import the domains registering through it.
 * An untyped `Error` (the `need()` guards in tools/curated.ts, for instance)
 * has no code and renders exactly as before.
 */
function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const { code } = error as { code?: unknown };
  return typeof code === "string" && code !== "" ? `[${code}] ${error.message}` : error.message;
}
