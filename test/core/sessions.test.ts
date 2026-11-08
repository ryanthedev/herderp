// Tests for the terminal -> Claude session join (src/core/sessions.ts)
// against a temp ~/.claude/sessions.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionLookup, isClaudeTerminal } from "../../src/core/sessions.js";
import type { CoreTerminal } from "../../src/core/types.js";

const SESSION = "ff1fc07d-9002-48b1-afa9-2e44e7ac6d73";
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "herderp-sessions-"));
  await writeFile(join(dir, "3096.json"), JSON.stringify({ pid: 3096, sessionId: SESSION, cwd: "/x" }));
  await writeFile(join(dir, "4000.json"), JSON.stringify({ pid: 9999, sessionId: SESSION }));
  await writeFile(join(dir, "4001.json"), "{not json");
  await writeFile(join(dir, "4002.json"), JSON.stringify({ pid: 4002, sessionId: "../../etc/passwd" }));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

function terminal(over: Partial<CoreTerminal> = {}): CoreTerminal {
  return {
    address: "t3s",
    name: null,
    state: "live",
    app: "claude-code",
    status: "working",
    blockedKind: null,
    message: "",
    title: "",
    turn: 0,
    cwd: "/x",
    foreground: { pid: 3096, argv: ["claude"], cwd: "/x" },
    labels: {},
    parent: null,
    spaceId: null,
    tabId: null,
    where: null,
    machine: null,
    ...over,
  };
}

describe("createSessionLookup", () => {
  it("reads the foreground pid's session file", async () => {
    expect(await createSessionLookup(dir)(terminal())).toBe(SESSION);
  });

  it("is null for a remote terminal, a finished one, or a foreground that isn't Claude", async () => {
    const lookup = createSessionLookup(dir);
    expect(await lookup(terminal({ machine: "ska", address: "ska/t3s" }))).toBeNull();
    expect(await lookup(terminal({ foreground: null }))).toBeNull();
    // A reused pid owned by another program must not borrow the session.
    expect(await lookup(terminal({ app: "", foreground: { pid: 3096, argv: ["vim"], cwd: "/x" } }))).toBeNull();
  });

  it("is null when the file is missing, malformed, names another pid, or holds a non-UUID", async () => {
    const lookup = createSessionLookup(dir);
    for (const pid of [1, 4000, 4001, 4002]) {
      expect(await lookup(terminal({ foreground: { pid, argv: ["claude"], cwd: "/x" } }))).toBeNull();
    }
  });

  it("recognizes Claude by reported app or by argv[0]", () => {
    expect(isClaudeTerminal(terminal())).toBe(true);
    expect(isClaudeTerminal(terminal({ app: "", foreground: { pid: 1, argv: ["/opt/bin/claude", "-c"], cwd: "/" } }))).toBe(true);
    expect(isClaudeTerminal(terminal({ app: "codex", foreground: { pid: 1, argv: ["codex"], cwd: "/" } }))).toBe(false);
  });
});
