// Tests for CoreClient (src/core/client.ts): the `hc connect` transport
// against a fake process, raw-terminal mapping against a payload copied from
// live herdr-core 0.1.18, and herdr-app error mapping against a stub runner.

import { describe, expect, it } from "bun:test";
import {
  createConnectRpc,
  createCoreClient,
  machineOf,
  toCoreTerminal,
  type AppRunner,
  type ConnectSpawn,
  type CoreRpc,
} from "../../src/core/client.js";
import { CoreError } from "../../src/core/types.js";

/** The CoreError a promise rejects with; fails the test if it resolves. */
const failure = (p: Promise<unknown>): Promise<CoreError> =>
  p.then(
    () => {
      throw new Error("expected a rejection");
    },
    (e: unknown) => e as CoreError,
  );

/** A fake `hc connect`: answers each written request with `respond(request)`'s lines. */
function fakeConnect(respond: (request: { id: number; method: string; params: unknown }) => string[] | "hang" | "eof") {
  const written: string[] = [];
  let killed = 0;
  const spawn: ConnectSpawn = () => {
    let push!: (chunk: string | null) => void;
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (chunk) => (chunk === null ? controller.close() : controller.enqueue(new TextEncoder().encode(chunk)));
      },
    });
    return {
      stdin: {
        write(chunk: string) {
          written.push(chunk);
          const request = JSON.parse(chunk);
          const reply = respond(request);
          if (reply === "eof") queueMicrotask(() => push(null));
          else if (reply !== "hang") queueMicrotask(() => push(reply.join("\n") + "\n"));
        },
        end() {},
      },
      stdout,
      stderr: new ReadableStream({ start: (c) => c.close() }),
      exited: Promise.resolve(0),
      kill() {
        killed++;
      },
    };
  };
  return { spawn, written, killed: () => killed };
}

const RAW_TERMINAL = {
  address: "t3s",
  argv: ["/bin/zsh", "-l"],
  cols: 265,
  created_ms: 1794166008507,
  cwd: "/Users/r/.config",
  foreground: { argv: ["claude", "--settings", "x.json"], cwd: "/Users/r/repos/herderp", name: "2.1.319", pid: 3096 },
  identity: "ghostty",
  keep: true,
  labels: { "herdr.seen": "0", "herdr.space": "sp6d1e", "herdr.tab": "tbb686", where: "herderp / 1" },
  name: null,
  parent: null,
  rows: 37,
  screen: "exact",
  state: "live",
  status: { app: "claude-code", msg: "Finding things", state: "working" },
  title: "Herdr desktop app support",
  turn: 4,
};

describe("createConnectRpc", () => {
  it("returns the result of the reply with its own id, skipping heartbeats, events and other ids", async () => {
    const fake = fakeConnect((req) => [
      `{"jsonrpc":"2.0","method":"heartbeat","params":{"seq":1}}`,
      `not json at all`,
      `[1,2,3]`,
      JSON.stringify({ jsonrpc: "2.0", id: req.id + 1000, result: "someone else's" }),
      JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { ok: 1 } }),
    ]);
    const rpc = createConnectRpc(["hc", "connect"], fake.spawn);
    expect(await rpc("server.status", {})).toEqual({ ok: 1 });
    expect(JSON.parse(fake.written[0]!)).toMatchObject({ jsonrpc: "2.0", method: "server.status", params: {} });
    expect(fake.killed()).toBe(1);
  });

  it("maps an RPC error's data.kind to the CoreError code and keeps the hint", async () => {
    const fake = fakeConnect((req) => [
      JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message: 'no terminal "t9"', data: { kind: "not_found", hint: "see `hc ls --all`" } } }),
    ]);
    const rpc = createConnectRpc(["hc", "connect"], fake.spawn);
    const error = await failure(rpc("terminal.get", { terminal: "t9" }));
    expect(error).toBeInstanceOf(CoreError);
    expect(error.code).toBe("not_found");
    expect(error.message).toBe('no terminal "t9" (see `hc ls --all`)');
  });

  it("reports core_unreachable when the stream ends before the reply", async () => {
    const rpc = createConnectRpc(["hc", "connect"], fakeConnect(() => "eof").spawn);
    const error = await failure(rpc("terminal.list", {}));
    expect(error.code).toBe("core_unreachable");
  });

  it("times out a hung core and still kills the process", async () => {
    const fake = fakeConnect(() => "hang");
    const rpc = createConnectRpc(["hc", "connect"], fake.spawn);
    const error = await failure(rpc("terminal.wait", {}, { timeoutMs: 20 }));
    expect(error.code).toBe("timeout");
    expect(fake.killed()).toBe(1);
  });

  it("reports not_installed when hc isn't on this machine", async () => {
    const rpc = createConnectRpc(["hc", "connect"], () => {
      throw Object.assign(new Error('Executable not found in $PATH: "hc"'), { code: "ENOENT" });
    });
    expect((await failure(rpc("x", {}))).code).toBe("not_installed");
  });

  it("reports core_unreachable when hc can't be started", async () => {
    const rpc = createConnectRpc(["hc", "connect"], () => {
      throw new Error("ENOENT: hc");
    });
    expect((await failure(rpc("x", {}))).code).toBe("core_unreachable");
  });
});

describe("toCoreTerminal", () => {
  it("maps the live payload: status, foreground, Herdr app labels", () => {
    expect(toCoreTerminal(RAW_TERMINAL)).toEqual({
      address: "t3s",
      name: null,
      state: "live",
      app: "claude-code",
      status: "working",
      blockedKind: null,
      message: "Finding things",
      title: "Herdr desktop app support",
      turn: 4,
      cwd: "/Users/r/repos/herderp",
      foreground: { pid: 3096, argv: ["claude", "--settings", "x.json"], cwd: "/Users/r/repos/herderp" },
      labels: RAW_TERMINAL.labels,
      parent: null,
      spaceId: "sp6d1e",
      tabId: "tbb686",
      where: "herderp / 1",
      machine: null,
    });
  });

  it("tolerates a plain shell: no status, no foreground, falls back to the launch cwd", () => {
    const t = toCoreTerminal({ address: "ska/t7", state: "finished", cwd: "/srv", labels: {}, status: null, foreground: null });
    expect(t).toMatchObject({ status: null, app: "", foreground: null, cwd: "/srv", machine: "ska", spaceId: null });
  });

  it("drops an unknown status word instead of widening the union", () => {
    expect(toCoreTerminal({ address: "t1", status: { state: "thinking" } }).status).toBeNull();
  });

  it("rejects an object with no address", () => {
    expect(() => toCoreTerminal({ state: "live" })).toThrow(CoreError);
  });

  it("machineOf splits a qualified address", () => {
    expect(machineOf("ska/t7")).toBe("ska");
    expect(machineOf("t7")).toBeNull();
  });
});

describe("createCoreClient", () => {
  const rpcOf = (results: Record<string, unknown>): { rpc: CoreRpc; calls: Array<[string, unknown, unknown]> } => {
    const calls: Array<[string, unknown, unknown]> = [];
    return {
      calls,
      rpc: async (method, params, opts) => {
        calls.push([method, params, opts]);
        return results[method];
      },
    };
  };

  it("lists terminals and machines", async () => {
    const { rpc } = rpcOf({ "terminal.list": { terminals: [RAW_TERMINAL], machines: [{ name: "ska", state: "connected", host: "x" }], hidden_finished: 3 } });
    const listing = await createCoreClient({ rpc }).terminalList();
    expect(listing.terminals.map((t) => t.address)).toEqual(["t3s"]);
    expect(listing.machines).toEqual([{ name: "ska", state: "connected" }]);
  });

  it("gives a history read and a waiting send more time than a plain call", async () => {
    const { rpc, calls } = rpcOf({ "terminal.read": { text: "x", complete: true, how: "history" }, "terminal.send": { turn: 2 } });
    const core = createCoreClient({ rpc });
    await core.terminalRead("t1", { lines: 100 });
    await core.terminalSend("t1", "hi", { wait: true, timeoutMs: 60_000 });
    expect(calls[0]).toEqual(["terminal.read", { terminal: "t1", lines: 100 }, { timeoutMs: 60_000 }]);
    expect(calls[1]![1]).toEqual({ terminal: "t1", text: "hi", wait: true, timeout: 60 });
    expect((calls[1]![2] as { timeoutMs: number }).timeoutMs).toBeGreaterThan(60_000);
  });

  it("rejects a read reply with no text", async () => {
    const { rpc } = rpcOf({ "terminal.read": { complete: true } });
    expect((await failure(createCoreClient({ rpc }).terminalRead("t1"))).code).toBe("bad_response");
  });

  const appOf = (stdout: string, exitCode = 0, stderr = ""): { app: AppRunner; calls: string[][] } => {
    const calls: string[][] = [];
    return { calls, app: async (argv) => (calls.push(argv), { stdout, stderr, exitCode }) };
  };

  it("sends a window command as one JSON object and returns its reply", async () => {
    const { app, calls } = appOf('{ "space": "sp1", "terminal": "t9" }');
    const reply = await createCoreClient({ rpc: async () => null, app }).appDo("space.new", { folder: "/x", name: "api" });
    expect(calls[0]).toEqual(["do", "space.new", '{"folder":"/x","name":"api"}']);
    expect(reply).toEqual({ space: "sp1", terminal: "t9" });
  });

  it("maps herdr-app's {error} to app_error and anything else failing to app_unreachable", async () => {
    const failed = await failure(
      createCoreClient({ rpc: async () => null, app: appOf('{ "error": "no such pane" }', 1).app }).appDo("pane.focus", { pane: "p" }),
    );
    expect(failed.code).toBe("app_error");
    expect(failed.message).toContain("no such pane");
    const down = await failure(createCoreClient({ rpc: async () => null, app: appOf("", 1, "window not running").app }).appSpaces());
    expect(down.code).toBe("app_unreachable");
  });

  it("maps herdr-app ls into spaces > tabs > terminal refs", async () => {
    const ls = {
      spaces: [
        {
          id: "sp1",
          name: "api",
          folder: "/x",
          machine: null,
          active: true,
          tabs: [{ id: "tb1", name: "1", active: true, terminals: [{ terminal: "t1", pane: "p1", status: "idle", app: "claude-code", name: null }] }],
        },
      ],
    };
    const spaces = await createCoreClient({ rpc: async () => null, app: appOf(JSON.stringify(ls)).app }).appSpaces();
    expect(spaces[0]!.tabs[0]!.terminals[0]).toEqual({ terminal: "t1", pane: "p1", status: "idle", app: "claude-code", name: null });
  });
});
