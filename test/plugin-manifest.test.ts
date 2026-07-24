// Static structural validation of the plugin manifest and MCP registration
// file, against the schema confirmed against current Claude Code plugin
// docs during discovery (code.claude.com/docs/en/plugins.md,
// plugins-reference.md).
//
// Honest limit: this validates *shape*, not that a live Claude Code host
// actually loads the plugin without error - that requires a running Claude
// Code instance, which isn't automatable in this environment. DW-1.2's
// "plugin loads with no manifest error" is covered at the static-schema
// level; a live-load check is out of scope for a unit test suite.

import { describe, expect, it } from "bun:test";
import path from "node:path";
import { SERVER_VERSION } from "../src/server.js";

const ROOT = path.join(import.meta.dir, "..");

describe("plugin manifest (.claude-plugin/plugin.json)", () => {
  it("DW_1_2_declares_the_plugin_with_a_required_name_field", async () => {
    const manifest = await Bun.file(path.join(ROOT, ".claude-plugin", "plugin.json")).json();
    expect(typeof manifest.name).toBe("string");
    expect(manifest.name.length).toBeGreaterThan(0);
    // kebab-case, matching plugin directory convention
    expect(manifest.name).toMatch(/^[a-z0-9-]+$/);
  });

  it("does not declare mcpServers inline (registered via sibling .mcp.json instead)", async () => {
    const manifest = await Bun.file(path.join(ROOT, ".claude-plugin", "plugin.json")).json();
    expect(manifest.mcpServers).toBeUndefined();
  });

  // Regression guard: plugin.json's version silently lagged two releases
  // behind package.json (shipped 0.6.0 while the manifest still said 0.5.0)
  // because nothing checked. The manifest, the package, and the version the
  // running server reports over MCP must move together.
  it("keeps plugin.json, package.json, and SERVER_VERSION in lockstep", async () => {
    const manifest = await Bun.file(path.join(ROOT, ".claude-plugin", "plugin.json")).json();
    const pkg = await Bun.file(path.join(ROOT, "package.json")).json();
    expect(manifest.version).toBe(pkg.version);
    expect(SERVER_VERSION).toBe(pkg.version);
  });
});

describe("MCP registration (.mcp.json)", () => {
  it("DW_1_2_registers_the_derp_stdio_server_at_the_plugin_root", async () => {
    const mcpConfig = await Bun.file(path.join(ROOT, ".mcp.json")).json();
    expect(mcpConfig.mcpServers).toBeDefined();

    const derp = mcpConfig.mcpServers.derp;
    expect(derp).toBeDefined();
    expect(typeof derp.command).toBe("string");
    expect(Array.isArray(derp.args)).toBe(true);
  });

  it("uses ${CLAUDE_PLUGIN_ROOT} for the bundled server path, not a hardcoded path", async () => {
    const mcpConfig = await Bun.file(path.join(ROOT, ".mcp.json")).json();
    const derp = mcpConfig.mcpServers.derp;
    const argsString = derp.args.join(" ");
    expect(argsString).toContain("${CLAUDE_PLUGIN_ROOT}");
    expect(argsString).not.toContain(ROOT);
  });
});
