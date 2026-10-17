// Unit tests for the host registry (src/herdr/hosts.ts) and its MCP face
// (src/tools/hosts.ts).
//
// Two layers of proof. Most tests inject a spawn stub and assert on the
// exact ssh argv the registry builds. The end-to-end block instead points
// `sshCommand` at a FAKE ssh (a shell script that runs the "remote" command
// string through a real `sh`, the way sshd's login shell would) and `herdr`
// at a fake herdr that records the argv it received - so the single-quoting
// that carries a prompt across the ssh boundary is exercised by an actual
// shell, not by our own idea of what a shell does. No network, no real herdr.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  EXIT_TRAILER,
  createHostRegistry,
  createSshRunner,
  defaultHostsPath,
  parseExitTrailer,
  shellQuote,
  sshArgv,
} from "../../src/herdr/hosts.js";
import type { HostRegistry, SpawnFn } from "../../src/herdr/hosts.js";
import type { HerdrClient, HerdrRunResult } from "../../src/herdr/client.js";
import { registerHostTools } from "../../src/tools/hosts.js";
import { HerdrError } from "../../src/herdr/types.js";

const SKA = { ssh: "100.64.0.10", user: "jane.doe@corp.example", herdr: "/opt/homebrew/bin/herdr" };
/** What every remote command string ends with: the in-band exit status. */
const TRAILER = ` ; printf '\\n${EXIT_TRAILER}%s\\n' "$?"`;

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "herderp-hosts-"));
  file = path.join(dir, "nested", "hosts.json");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function recordingSpawn(reply: Partial<HerdrRunResult> = {}): { spawn: SpawnFn; calls: string[][] } {
  const calls: string[][] = [];
  const spawn: SpawnFn = async (argv) => {
    calls.push(argv);
    return { stdout: "", stderr: "", exitCode: 0, ...reply };
  };
  return { spawn, calls };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<HerdrError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HerdrError);
    expect((error as HerdrError).code).toBe(code);
    return error as HerdrError;
  }
  throw new Error(`expected a HerdrError with code ${code}`);
}

describe("shellQuote / sshArgv", () => {
  it("single-quotes every remote argument so the remote shell passes it through verbatim", () => {
    expect(shellQuote("plain")).toBe("'plain'");
    expect(shellQuote("it's $HOME; echo x")).toBe(`'it'\\''s $HOME; echo x'`);
  });

  it("builds a non-interactive ssh exec with the remote herdr binary and env", () => {
    const argv = sshArgv(SKA, ["agent", "prompt", "w1:p1", "say hi"]);
    expect(argv.slice(0, -2)).toEqual([
      "ssh", "-n",
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", "ConnectTimeout=10",
      "-l", "jane.doe@corp.example",
    ]);
    expect(argv.at(-2)).toBe("100.64.0.10");
    expect(argv.at(-1)).toBe(
      `env PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH" '/opt/homebrew/bin/herdr' 'agent' 'prompt' 'w1:p1' 'say hi'${TRAILER}`,
    );
  });

  it("omits -l without a user, defaults the binary to herdr, and sets HERDR_SOCKET_PATH when a socket is given", () => {
    const argv = sshArgv({ ssh: "box", socket: "/tmp/other.sock" }, ["session", "list", "--json"], "/fake/ssh");
    expect(argv[0]).toBe("/fake/ssh");
    expect(argv).not.toContain("-l");
    expect(argv.at(-1)).toBe(
      `env PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH" 'HERDR_SOCKET_PATH=/tmp/other.sock' 'herdr' 'session' 'list' '--json'${TRAILER}`,
    );
  });
});

describe("parseExitTrailer", () => {
  it("strips exactly the trailer, preserving a terminated or unterminated last line", () => {
    expect(parseExitTrailer(`abc\n\n${EXIT_TRAILER}0\n`, 0)).toEqual({ stdout: "abc\n", exitCode: 0 });
    expect(parseExitTrailer(`abc\n${EXIT_TRAILER}1\n`, 0)).toEqual({ stdout: "abc", exitCode: 1 });
    expect(parseExitTrailer(`\n${EXIT_TRAILER}127\n`, 0)).toEqual({ stdout: "", exitCode: 127 });
  });

  it("falls back to ssh's own exit code when no trailer arrived", () => {
    expect(parseExitTrailer("garbage", 9)).toEqual({ stdout: "garbage", exitCode: 9 });
  });
});

describe("createSshRunner", () => {
  it("takes herdr's exit status from the trailer even when ssh reports 0 (Tailscale SSH)", async () => {
    const { spawn } = recordingSpawn({
      exitCode: 0,
      stdout: `\n${EXIT_TRAILER}1\n`,
      stderr: `{"error":{"code":"agent_not_found","message":"nope"}}\n`,
    });
    const runner = createSshRunner("ska", SKA, spawn);
    const outcome = await runner(["agent", "get", "x"]);
    expect(outcome).toEqual({ exitCode: 1, stdout: "", stderr: `{"error":{"code":"agent_not_found","message":"nope"}}\n` });
  });

  it("maps ssh's own failure (exit 255) to host_unreachable with the ssh message", async () => {
    const { spawn } = recordingSpawn({ exitCode: 255, stderr: "ssh: connect to host box port 22: Operation timed out\n" });
    const runner = createSshRunner("box", { ssh: "box" }, spawn);
    const error = await expectCode(runner(["agent", "list"]), "host_unreachable");
    expect(error.message).toBe('host "box" (box): ssh: connect to host box port 22: Operation timed out');
  });

  it("passes herdr's own exit code and streams through, minus ssh's first-contact notice", async () => {
    const { spawn } = recordingSpawn({
      exitCode: 1,
      stderr: `Warning: Permanently added 'box' (ED25519) to the list of known hosts.\n{"error":{"code":"agent_not_found","message":"nope"}}\n`,
    });
    const runner = createSshRunner("box", { ssh: "box" }, spawn);
    const outcome = await runner(["agent", "get", "x"]);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr.trim()).toBe(`{"error":{"code":"agent_not_found","message":"nope"}}`);
  });
});

describe("HostRegistry file handling", () => {
  it("defaults the registry path to ~/.config/herderp/hosts.json unless HERDERP_HOSTS_PATH overrides it", () => {
    expect(defaultHostsPath({})).toBe(path.join(os.homedir(), ".config", "herderp", "hosts.json"));
    expect(defaultHostsPath({ HERDERP_HOSTS_PATH: "/elsewhere/h.json" })).toBe("/elsewhere/h.json");
  });

  it("treats a missing file as an empty registry", async () => {
    const registry = createHostRegistry({ path: file });
    expect(await registry.list()).toEqual([]);
  });

  it("add creates parent directories, writes the file, and later calls see the entry without a restart", async () => {
    const registry = createHostRegistry({ path: file });
    const record = await registry.add("ska", SKA);
    expect(record).toEqual({ name: "ska", ...SKA });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ hosts: { ska: SKA } });
    expect(await registry.list()).toEqual([record]);
    expect(await registry.get("ska")).toEqual(record);
  });

  it("accepts the user@host string shorthand in a hand-edited file", async () => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ hosts: { box: "me@box", full: { ssh: "10.0.0.2", herdr: "/x/herdr" } } }), "utf8");
    const registry = createHostRegistry({ path: file });
    expect(await registry.list()).toEqual([
      { name: "box", ssh: "me@box" },
      { name: "full", ssh: "10.0.0.2", herdr: "/x/herdr" },
    ]);
  });

  it("remove drops the entry and rejects an unknown name with the known list", async () => {
    const registry = createHostRegistry({ path: file });
    await registry.add("a", { ssh: "a" });
    await registry.add("b", { ssh: "b" });
    await registry.remove("a");
    expect((await registry.list()).map((h) => h.name)).toEqual(["b"]);
    const error = await expectCode(registry.remove("zzz"), "unknown_host");
    expect(error.message).toContain("known hosts: b");
  });

  it("an unknown host with an empty registry says how to add one", async () => {
    const registry = createHostRegistry({ path: file });
    const error = await expectCode(registry.get("ska"), "unknown_host");
    expect(error.message).toContain("no hosts are registered");
    expect(error.message).toContain(file);
  });

  it("rejects bad names, the reserved name local, and malformed entries", async () => {
    const registry = createHostRegistry({ path: file });
    await expectCode(registry.add("bad name", { ssh: "x" }), "invalid_host_name");
    await expectCode(registry.add("-dash", { ssh: "x" }), "invalid_host_name");
    await expectCode(registry.add("local", { ssh: "x" }), "invalid_host_name");
    await expectCode(registry.add("ok", { ssh: "" }), "invalid_host_entry");
    await expectCode(registry.add("ok", { ssh: "-oProxyCommand=evil" }), "invalid_host_entry");
    await expectCode(registry.add("ok", { ssh: "x", herdr: "a\nb" }), "invalid_host_entry");
    expect(await registry.list()).toEqual([]);
  });

  it("a malformed file is invalid_hosts_file naming the path, never a crash", async () => {
    const registry = createHostRegistry({ path: file });
    await registry.add("x", { ssh: "x" });
    await writeFile(file, "{ not json", "utf8");
    const error = await expectCode(registry.list(), "invalid_hosts_file");
    expect(error.message).toContain(file);
    await writeFile(file, JSON.stringify({ hosts: { x: { herdr: "/h" } } }), "utf8");
    expect((await expectCode(registry.list(), "invalid_hosts_file")).message).toContain('missing "ssh"');
    await writeFile(file, JSON.stringify({ hosts: [] }), "utf8");
    await expectCode(registry.list(), "invalid_hosts_file");
  });
});

describe("HostRegistry.clientFor", () => {
  const local = { marker: "local" } as unknown as HerdrClient;

  it("returns the local client for no host, an empty host, or 'local'", async () => {
    const registry = createHostRegistry({ path: file, localClient: local });
    expect(await registry.clientFor()).toBe(local);
    expect(await registry.clientFor("")).toBe(local);
    expect(await registry.clientFor("local")).toBe(local);
  });

  it("returns an ssh-backed client for a registered host whose calls go through ssh", async () => {
    const { spawn, calls } = recordingSpawn({
      stdout: JSON.stringify({
        id: "x",
        result: {
          agents: [{ agent: "claude", agent_status: "idle", cwd: "/r", workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1" }],
        },
      }),
    });
    const registry = createHostRegistry({ path: file, localClient: local, spawn });
    await registry.add("ska", SKA);
    const client = await registry.clientFor("ska");
    expect(client).not.toBe(local);
    const agents = await client.agentList();
    expect(agents.map((a) => a.paneId)).toEqual(["w1:p1"]);
    expect(calls).toEqual([sshArgv(SKA, ["agent", "list"])]);
  });

  it("an unreachable host surfaces from a client call as host_unreachable, not spawn_failed", async () => {
    const { spawn } = recordingSpawn({ exitCode: 255, stderr: "ssh: Could not resolve hostname" });
    const registry = createHostRegistry({ path: file, spawn });
    await registry.add("ska", SKA);
    const client = await registry.clientFor("ska");
    await expectCode(client.agentList(), "host_unreachable");
  });

  it("clientFor rejects an unregistered name", async () => {
    const registry = createHostRegistry({ path: file, localClient: local });
    await expectCode(registry.clientFor("ghost"), "unknown_host");
  });
});

describe("HostRegistry.check", () => {
  it("runs --version then session list over ssh and reports both", async () => {
    const calls: string[][] = [];
    const spawn: SpawnFn = async (argv) => {
      calls.push(argv);
      const remote = argv.at(-1)!;
      if (remote.includes("'--version'")) return { stdout: "herdr 0.7.3\n", stderr: "", exitCode: 0 };
      return {
        stdout: JSON.stringify({ sessions: [{ name: "default", default: true, running: true }] }),
        stderr: "",
        exitCode: 0,
      };
    };
    const registry = createHostRegistry({ path: file, spawn });
    await registry.add("ska", SKA);
    const check = await registry.check("ska");
    expect(check).toEqual({
      name: "ska",
      ...SKA,
      version: "0.7.3",
      sessions: [{ name: "default", default: true, running: true }],
    });
    const remotes = calls.map((c) => c.at(-1)!);
    expect(remotes[0]).toContain("'/opt/homebrew/bin/herdr' '--version'");
    expect(remotes[1]).toContain("'/opt/homebrew/bin/herdr' 'session' 'list' '--json'");
  });

  it("a remote without herdr on PATH is command_failed carrying the shell's message", async () => {
    const { spawn } = recordingSpawn({ exitCode: 127, stderr: "zsh:1: command not found: herdr\n" });
    const registry = createHostRegistry({ path: file, spawn });
    await registry.add("box", { ssh: "box" });
    const error = await expectCode(registry.check("box"), "command_failed");
    expect(error.message).toContain("command not found: herdr");
  });
});

describe("end to end through a real shell (fake ssh + fake herdr)", () => {
  let fakeSsh: string;
  let fakeHerdr: string;
  let argvLog: string;

  beforeEach(async () => {
    fakeSsh = path.join(dir, "ssh");
    fakeHerdr = path.join(dir, "herdr");
    argvLog = path.join(dir, "argv.log");
    // sshd hands the command string to the login shell; this does the same
    // with sh. The command is always ssh's last argument.
    await writeFile(fakeSsh, '#!/bin/sh\neval "cmd=\\${$#}"\nexec sh -c "$cmd"\n', "utf8");
    // Records its argv NUL-separated (so spaces and quotes survive), records
    // the socket env it saw, and answers like herdr's `agent list`.
    await writeFile(
      fakeHerdr,
      `#!/bin/sh\n: > "${argvLog}"\nfor a in "$@"; do printf '%s\\0' "$a" >> "${argvLog}"; done\n` +
        `printf '%s' "$HERDR_SOCKET_PATH" > "${argvLog}.sock"\n` +
        `if [ "$1" = "--version" ]; then echo "herdr 9.9.9"; exit 0; fi\n` +
        `if [ "$1" = "agent" ] && [ "$2" = "prompt" ]; then exit 0; fi\n` +
        `echo '{"id":"cli:agent:list","result":{"agents":[{"agent":"claude","agent_status":"idle","cwd":"/remote","workspace_id":"w1","tab_id":"w1:t1","pane_id":"w1:p1"}]}}'\n`,
      "utf8",
    );
    await chmod(fakeSsh, 0o755);
    await chmod(fakeHerdr, 0o755);
  });

  async function recordedArgv(): Promise<string[]> {
    const raw = await readFile(argvLog, "utf8");
    return raw.split("\0").slice(0, -1);
  }

  it("a prompt full of shell metacharacters crosses the ssh boundary as exactly one argument", async () => {
    const registry = createHostRegistry({ path: file, sshCommand: fakeSsh });
    await registry.add("fake", { ssh: "ignored-by-fake", herdr: fakeHerdr, socket: "/srv/other.sock" });
    const client = await registry.clientFor("fake");

    const text = `it's "quoted"; $HOME && touch /nope | echo \`x\` \\ done`;
    await client.agentPrompt("w1:p1", text, { wait: true, until: "done", timeoutMs: 5 });
    expect(await recordedArgv()).toEqual(["agent", "prompt", "w1:p1", text, "--wait", "--until", "done", "--timeout", "5"]);
    expect(await readFile(`${argvLog}.sock`, "utf8")).toBe("/srv/other.sock");

    const agents = await client.agentList();
    expect(agents.map((a) => a.cwd)).toEqual(["/remote"]);
  });

  it("check reaches the remote binary through the same path", async () => {
    const registry = createHostRegistry({ path: file, sshCommand: fakeSsh });
    await registry.add("fake", { ssh: "ignored", herdr: fakeHerdr });
    // The fake answers `session list` with an agent-list body, which is the
    // wrong shape: that surfaces as invalid_response (a parse failure past
    // the transport), proving --version and the ssh hop both succeeded.
    await expectCode(registry.check("fake"), "invalid_response");
    expect(await recordedArgv()).toEqual(["session", "list", "--json"]);
  });
});

describe("herdr_host tool", () => {
  type Registered = {
    handler: (args: unknown, extra: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
  };

  function withTool(registry: HostRegistry) {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerHostTools(server, registry);
    const tool = (server as unknown as { _registeredTools: Record<string, Registered> })._registeredTools.herdr_host!;
    return async (args: unknown) => {
      const result = await tool.handler(args, {});
      const text = result.content[0]!.text;
      return { isError: result.isError, text, body: result.isError ? {} : (JSON.parse(text) as Record<string, unknown>) };
    };
  }

  it("list/add/remove round-trip through the registry and name the file", async () => {
    const registry = createHostRegistry({ path: file });
    const call = withTool(registry);
    expect((await call({ action: "list" })).body).toMatchObject({ hosts: [], path: file });
    const added = await call({ action: "add", name: "ska", ...SKA });
    expect(added.body).toMatchObject({ ok: true, host: { name: "ska", ...SKA } });
    expect(added.body.hint as string).toContain("check");
    expect((await call({ action: "list" })).body.hosts).toEqual([{ name: "ska", ...SKA }]);
    expect((await call({ action: "remove", name: "ska" })).body.ok).toBe(true);
    expect((await call({ action: "list" })).body.hosts).toEqual([]);
  });

  it("names the missing field and surfaces registry error codes", async () => {
    const call = withTool(createHostRegistry({ path: file }));
    expect((await call({ action: "add", name: "x" })).text).toBe('herdr_host{action:"add"} requires "ssh"');
    expect((await call({ action: "check" })).text).toBe('herdr_host{action:"check"} requires "name"');
    expect((await call({ action: "check", name: "nope" })).text).toStartWith("[unknown_host]");
    expect((await call({ action: "add", name: "local", ssh: "x" })).text).toStartWith("[invalid_host_name]");
  });
});
