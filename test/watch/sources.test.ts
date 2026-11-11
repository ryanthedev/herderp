// Tests for herdr-core's side of the watch: the event stream
// (src/core/events.ts) against a fake `hc connect`, the core WatchSource
// (src/watch/sources.ts), and runWatch driving a core target end to end.

import { describe, expect, it } from "bun:test";
import { subscribeCoreEvents, type CoreEvent } from "../../src/core/events.js";
import type { ConnectSpawn, CoreClient } from "../../src/core/client.js";
import { CoreError, type CoreTerminal } from "../../src/core/types.js";
import { coreSource, type WatchSource } from "../../src/watch/sources.js";
import { runWatch } from "../../src/watch/run.js";

/** A fake `hc connect` whose stdout the test writes to. */
function fakeStream() {
  let push!: (line: string | null) => void;
  const written: string[] = [];
  const spawn: ConnectSpawn = () => ({
    stdin: { write: (c: string) => void written.push(c), end() {} },
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        push = (line) => (line === null ? controller.close() : controller.enqueue(new TextEncoder().encode(`${line}\n`)));
      },
    }),
    stderr: new ReadableStream({ start: (c) => c.close() }),
    exited: Promise.resolve(0),
    kill() {},
  });
  return { spawn, written, push: (line: string | null) => push(line) };
}

let seq = 100;
const event = (type: string, terminal: string, data: Record<string, unknown>, at = ++seq) =>
  JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type, terminal, seq: at, data } });

describe("subscribeCoreEvents", () => {
  it("subscribes, then delivers events and ignores heartbeats and junk", async () => {
    const fake = fakeStream();
    const events: CoreEvent[] = [];
    const pending = subscribeCoreEvents({ spawn: fake.spawn, onEvent: (e) => events.push(e), onClose: () => {} });
    expect(JSON.parse(fake.written[0]!)).toMatchObject({ method: "events.subscribe", params: {} });
    fake.push(`{"jsonrpc":"2.0","id":1,"result":{"seq":5,"terminals":[]}}`);
    const stream = await pending;
    fake.push(`{"jsonrpc":"2.0","method":"heartbeat","params":{"seq":6}}`);
    fake.push("garbage");
    fake.push(event("status", "t1", { status: { state: "done" } }));
    await Bun.sleep(5);
    expect(events).toEqual([{ type: "status", terminal: "t1", data: { status: { state: "done" } } }]);
    stream.close();
  });

  it("drops events at or below the snapshot's seq, and replays of older ones", async () => {
    const fake = fakeStream();
    const events: CoreEvent[] = [];
    const pending = subscribeCoreEvents({ spawn: fake.spawn, onEvent: (e) => events.push(e), onClose: () => {} });
    fake.push(`{"jsonrpc":"2.0","id":1,"result":{"seq":50,"terminals":[]}}`);
    const stream = await pending;
    fake.push(event("status", "t1", { status: { state: "working" } }, 49));
    fake.push(event("status", "t1", { status: { state: "done" } }, 52));
    fake.push(event("status", "t1", { status: { state: "working" } }, 51));
    await Bun.sleep(5);
    expect(events.map((e) => (e.data.status as { state: string }).state)).toEqual(["done"]);
    stream.close();
  });

  it("rejects a refused subscription with the core's code", async () => {
    const fake = fakeStream();
    const pending = subscribeCoreEvents({ spawn: fake.spawn, onEvent: () => {}, onClose: () => {} });
    fake.push(`{"jsonrpc":"2.0","id":1,"error":{"message":"nope","data":{"kind":"denied"}}}`);
    expect((await pending.catch((e) => e)).code).toBe("denied");
  });

  it("calls onClose once when the stream ends, and when it goes quiet past the grace", async () => {
    for (const ending of ["eof", "silence"] as const) {
      const fake = fakeStream();
      const reasons: string[] = [];
      const pending = subscribeCoreEvents({ spawn: fake.spawn, onEvent: () => {}, onClose: (r) => reasons.push(r), heartbeatGraceMs: 30 });
      fake.push(`{"jsonrpc":"2.0","id":1,"result":{"seq":0,"terminals":[]}}`);
      await pending;
      if (ending === "eof") fake.push(null);
      await Bun.sleep(60);
      expect(reasons.length).toBe(1);
    }
  });

  it("a deliberate close does not call onClose", async () => {
    const fake = fakeStream();
    const reasons: string[] = [];
    const pending = subscribeCoreEvents({ spawn: fake.spawn, onEvent: () => {}, onClose: (r) => reasons.push(r), heartbeatGraceMs: 20 });
    fake.push(`{"jsonrpc":"2.0","id":1,"result":{"seq":0,"terminals":[]}}`);
    (await pending).close();
    fake.push(null);
    await Bun.sleep(40);
    expect(reasons).toEqual([]);
  });
});

function terminal(over: Partial<CoreTerminal> = {}): CoreTerminal {
  return {
    address: "t7", name: "review", state: "live", app: "claude-code", status: "working", blockedKind: null, message: "",
    title: "", turn: 0, cwd: "/b", foreground: { pid: 7, argv: ["claude"], cwd: "/b" }, labels: {}, argv: [], createdMs: null, parent: null,
    spaceId: null, tabId: null, where: null, machine: null, ...over,
  };
}

/** A core source over a scripted core and a scripted event stream. */
function scriptedCore(answers: () => CoreTerminal | CoreError) {
  let emit!: (e: CoreEvent) => void;
  let close!: (reason: string) => void;
  const core = {
    terminalGet: async () => {
      const a = answers();
      if (a instanceof CoreError) throw a;
      return a;
    },
  } as unknown as CoreClient;
  const source = coreSource(core, async () => "22222222-2222-2222-2222-222222222222", async (options) => {
    emit = options.onEvent;
    close = options.onClose;
    return { close() {} };
  });
  return { source, emit: (e: CoreEvent) => emit(e), close: (r: string) => close(r) };
}

describe("coreSource", () => {
  it("get canonicalizes a name to the address and joins the session", async () => {
    const { source } = scriptedCore(() => terminal());
    expect(await source.get("review")).toEqual({ key: "t7", status: "working", sessionId: "22222222-2222-2222-2222-222222222222", cwd: "/b" });
  });

  it("a finished or removed terminal reads as gone; other errors are transient", async () => {
    const finished = scriptedCore(() => terminal({ state: "finished" })).source;
    const err = await finished.get("t7").catch((e) => e);
    expect(finished.goneDetail(err)).toContain("ended");
    expect(finished.goneDetail(new CoreError("not_found", "x"))).toContain("removed");
    expect(finished.goneDetail(new CoreError("timeout", "x"))).toBeNull();
  });

  it("maps status, stop-reporting, and finished events for watched terminals only", async () => {
    const s = scriptedCore(() => terminal());
    const seen: string[] = [];
    await s.source.subscribe(["t7"], { status: (k, st) => seen.push(`${k} ${st}`), gone: (k, d) => seen.push(`${k} gone ${d}`) }, () => {});
    s.emit({ type: "status", terminal: "t9", data: { status: { state: "done" } } });
    s.emit({ type: "size", terminal: "t7", data: { cols: 90, rows: 30 } });
    s.emit({ type: "status", terminal: "t7", data: { status: { state: "error" } } });
    s.emit({ type: "status", terminal: "t7", data: { status: null } });
    s.emit({ type: "finished", terminal: "t7", data: {} });
    expect(seen).toEqual(["t7 error", "t7 gone agent exited (it stopped reporting status)", "t7 gone its program ended (terminal finished)"]);
  });

  it("an agent exiting to its shell is gone, even though core keeps its last status word", async () => {
    // Live 2026-11-08: after the reporting program exits, `hc get` still shows its old status.
    const atShell = terminal({ status: "done", foreground: { pid: 1, argv: ["/bin/zsh", "-li"], cwd: "/b" } });
    const s = scriptedCore(() => atShell);
    const err = await s.source.get("t7").catch((e) => e);
    expect(s.source.goneDetail(err)).toContain("back at its shell");
    const seen: string[] = [];
    await s.source.subscribe(["t7"], { status: () => {}, gone: (k, d) => seen.push(`${k} ${d}`) }, () => {});
    s.emit({ type: "foreground", terminal: "t7", data: { argv: ["sh", "/tmp/build.sh"], pid: 2 } }); // a script, not a prompt
    s.emit({ type: "foreground", terminal: "t7", data: { argv: ["-zsh"], pid: 3 } });
    expect(seen).toEqual(["t7 agent exited (the terminal is back at its shell)"]);
  });
});

describe("runWatch with a core target", () => {
  it("watches by address, reports a stop from the stream, and exits once gone", async () => {
    const s = scriptedCore(() => terminal());
    const lines: string[] = [];
    const run = runWatch(
      { targets: ["core:review"] },
      {
        sources: { core: s.source as WatchSource },
        projectsRoot: "/nonexistent",
        write: (line) => lines.push(line),
        readLastState: async () => "All done.",
        pollMs: 10_000,
        summaryDelayMs: 0,
      },
    );
    await Bun.sleep(10);
    s.emit({ type: "status", terminal: "t7", data: { status: { state: "done" } } });
    await Bun.sleep(10);
    s.emit({ type: "finished", terminal: "t7", data: {} });
    expect(await run).toBe(0);
    expect(lines[0]).toBe("[review] watching - currently working (session 22222222)");
    expect(lines[1]).toMatch(/^\[review\] done after \d+s working - last: "All done\." \(session 22222222\)$/);
    expect(lines[2]).toBe("[review] gone - its program ended (terminal finished)");
  });

  it("a lost core stream ends the watch with status 1 and says which engine", async () => {
    const s = scriptedCore(() => terminal());
    const lines: string[] = [];
    const run = runWatch(
      { targets: ["core:t7"] },
      { sources: { core: s.source }, projectsRoot: "/x", write: (l) => lines.push(l), readLastState: async () => undefined, pollMs: 10_000 },
    );
    await Bun.sleep(10);
    s.close("herdr-core's event stream closed");
    expect(await run).toBe(1);
    expect(lines.at(-1)).toContain("lost herdr-core (the Herdr app's engine)'s event stream");
  });

  it("a core target with no core source is a not-found, exit 2", async () => {
    const lines: string[] = [];
    const code = await runWatch(
      { targets: ["core:t7"], json: true },
      { sources: {}, projectsRoot: "/x", write: (l) => lines.push(l), readLastState: async () => undefined },
    );
    expect(code).toBe(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ type: "not_found", engine: "core", label: "t7" });
  });
});
