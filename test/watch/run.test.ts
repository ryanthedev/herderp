// Tests for the watch runner (src/watch/run.ts): a fake herdr socket server
// pushes status events, a stub HerdrClient answers agentGet, and a temp dir
// stands in for ~/.claude/projects. herdr itself is never spawned.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HerdrClient } from "../../src/herdr/client.js";
import { HerdrError, type Agent } from "../../src/herdr/types.js";
import { deriveSlug } from "../../src/necromancy/core.js";
import { runWatch, type RunWatchDeps, type RunWatchOptions } from "../../src/watch/run.js";

const SESSION = "11111111-1111-1111-1111-111111111111";
const CWD = "/tmp/watch-proj";
const AGENT: Agent = { agent: "claude", sessionId: SESSION, status: "working", cwd: CWD, workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" };

let dir: string;
let socketPath: string;
let projectsRoot: string;
let server: Server | undefined;
let herdrSocket: Socket | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "herderp-watch-"));
  socketPath = join(dir, "herdr.sock");
  projectsRoot = join(dir, "projects");
});

afterEach(async () => {
  herdrSocket?.destroy();
  server?.close();
  server = undefined;
  await rm(dir, { recursive: true, force: true });
});

/** A fake herdr that acks the subscription; push() sends status events. */
async function fakeHerdr(): Promise<{ push: (data: Record<string, unknown>) => void; drop: () => void }> {
  let ready!: () => void;
  const subscribed = new Promise<void>((r) => (ready = r));
  await new Promise<void>((resolve) => {
    server = createServer((socket) => {
      herdrSocket = socket;
      socket.once("data", (d) => {
        const req = JSON.parse(d.toString().split("\n")[0]!);
        socket.write(`${JSON.stringify({ id: req.id, result: { type: "subscription_started" } })}\n`);
        ready();
      });
    });
    server.listen(socketPath, () => resolve());
  });
  return {
    push: (data) => {
      void subscribed.then(() => herdrSocket!.write(`${JSON.stringify({ event: "pane.agent_status_changed", data })}\n`));
    },
    drop: () => void subscribed.then(() => herdrSocket!.end()),
  };
}

async function writeTranscript(): Promise<void> {
  const slugDir = join(projectsRoot, deriveSlug(CWD));
  await mkdir(slugDir, { recursive: true });
  await writeFile(join(slugDir, `${SESSION}.jsonl`), "{}\n");
}

function deps(lines: string[], client: Partial<HerdrClient> = {}, extra: Partial<RunWatchDeps> = {}): RunWatchDeps {
  return {
    client: { agentGet: async () => AGENT, ...client } as HerdrClient,
    socketPath,
    projectsRoot,
    write: (line) => lines.push(line),
    readLastState: async () => "Shipped the fix and all tests pass.",
    pollMs: 20,
    summaryDelayMs: 0,
    ...extra,
  };
}

const run = (options: RunWatchOptions, d: RunWatchDeps) => runWatch(options, d);

describe("runWatch", () => {
  it("announces the target, then reports it stopping with its last message, and exits 0 with once", async () => {
    await writeTranscript();
    const herdr = await fakeHerdr();
    const lines: string[] = [];
    const done = run({ targets: ["lead"], once: true }, deps(lines));
    herdr.push({ agent: "claude", agent_status: "done", pane_id: "w1:p1", workspace_id: "w1" });

    expect(await done).toBe(0);
    expect(lines[0]).toBe("[lead] watching - currently working (session 11111111)");
    expect(lines[1]).toMatch(/^\[lead\] done after \d+s working - last: "Shipped the fix and all tests pass\." \(session 11111111\)$/);
  });

  it("emits JSON lines with --json", async () => {
    await writeTranscript();
    const herdr = await fakeHerdr();
    const lines: string[] = [];
    const done = run({ targets: ["lead"], once: true, json: true }, deps(lines));
    herdr.push({ agent: "claude", agent_status: "blocked", pane_id: "w1:p1", workspace_id: "w1" });
    await done;
    expect(JSON.parse(lines[1]!)).toMatchObject({ type: "status", status: "blocked", label: "lead", sessionId: SESSION });
  });

  it("treats a null agent as the agent leaving, and exits 0 when every target is gone", async () => {
    await writeTranscript();
    const herdr = await fakeHerdr();
    const lines: string[] = [];
    const done = run({ targets: ["lead"] }, deps(lines));
    herdr.push({ agent: null, agent_status: "unknown", pane_id: "w1:p1", workspace_id: "w1" });
    expect(await done).toBe(0);
    expect(lines.at(-1)).toBe("[lead] gone - agent exited");
  });

  it("reports a stall when a working agent's transcript stops moving", async () => {
    await writeTranscript();
    await fakeHerdr();
    const lines: string[] = [];
    let clock = Date.now() + 60_000; // transcript mtime is "now"; the clock runs ahead of it
    const done = run({ targets: ["lead"], stallMs: 30_000, once: true }, deps(lines, {}, { now: () => (clock += 10_000) }));
    expect(await done).toBe(0);
    expect(lines.at(-1)).toMatch(/^\[lead\] stalled - no activity for \d+s while working$/);
  });

  it("holds stall detection until a transcript exists, then turns it on", async () => {
    await fakeHerdr();
    const lines: string[] = [];
    let clock = Date.now() + 60_000;
    const done = run({ targets: ["lead"], stallMs: 30_000, once: true }, deps(lines, {}, { pollMs: 5, now: () => (clock += 10_000) }));
    await new Promise((r) => setTimeout(r, 60));
    expect(lines).toEqual([
      "[lead] watching - currently working (session 11111111) - no transcript yet, stall detection starts when one appears",
    ]);
    await writeTranscript(); // the agent's first write lands
    expect(await done).toBe(0);
    expect(lines.at(-1)).toMatch(/^\[lead\] stalled - no activity for \d+[smh][\dm]* while working$/);
  });

  it("prints every line as JSON in json mode, including the start and failure lines", async () => {
    await writeTranscript();
    const herdr = await fakeHerdr();
    const lines: string[] = [];
    const done = run({ targets: ["lead"], json: true, stallMs: 600_000 }, deps(lines));
    herdr.push({ agent: "claude", agent_status: "done", pane_id: "w1:p1", workspace_id: "w1" });
    await new Promise((r) => setTimeout(r, 40));
    herdr.drop();
    expect(await done).toBe(1);
    const records = lines.map((l) => JSON.parse(l));
    expect(records.map((r) => r.type)).toEqual(["watching", "status", "stream_lost"]);
    expect(records[0]).toMatchObject({ label: "lead", paneId: "w1:p1", status: "working", sessionId: SESSION, stallDetection: true });

    const missing: string[] = [];
    const client = {
      agentGet: async () => {
        throw new HerdrError("agent_not_found", "nope");
      },
    };
    expect(await run({ targets: ["x"], json: true }, deps(missing, client))).toBe(2);
    expect(JSON.parse(missing[0]!)).toEqual({ type: "not_found", label: "x", detail: "nope" });
  });

  it("prints every departure in a batch before exiting", async () => {
    await writeTranscript();
    const herdr = await fakeHerdr();
    const lines: string[] = [];
    const agentGet = async (target: string) =>
      target === "cap" || target === "w1:p2" ? { ...AGENT, paneId: "w1:p2" } : AGENT;
    const done = run({ targets: ["lead", "cap"] }, deps(lines, { agentGet }));
    await new Promise((r) => setTimeout(r, 20));
    // both leave in one socket write
    herdrSocket!.write(
      `${JSON.stringify({ event: "pane.agent_status_changed", data: { agent: null, pane_id: "w1:p1" } })}\n` +
        `${JSON.stringify({ event: "pane.agent_status_changed", data: { agent: null, pane_id: "w1:p2" } })}\n`,
    );
    void herdr;
    expect(await done).toBe(0);
    expect(lines.slice(-2)).toEqual(["[lead] gone - agent exited", "[cap] gone - agent exited"]);
  });

  it("catches a stop that happened before the subscription went live", async () => {
    await writeTranscript();
    await fakeHerdr();
    const lines: string[] = [];
    let calls = 0;
    // working at the first lookup; done by the time the watch reconciles
    const client = { agentGet: async () => (++calls === 1 ? AGENT : { ...AGENT, status: "done" as const }) };
    expect(await run({ targets: ["lead"], once: true }, deps(lines, client, { pollMs: 60_000 }))).toBe(0);
    expect(lines.at(-1)).toMatch(/^\[lead\] done after \d+s working/);
  });

  it("quotes the session that stopped, even if the pane moves to a new session before the line prints", async () => {
    await writeTranscript();
    const herdr = await fakeHerdr();
    const lines: string[] = [];
    const NEW = "22222222-2222-2222-2222-222222222222";
    let stopped = false;
    // until the stop, the pane holds SESSION; right after it, a /clear moves it to NEW
    const client = { agentGet: async () => (stopped ? { ...AGENT, sessionId: NEW } : AGENT) };
    const quoted: string[] = [];
    const readLastState = async (sessionId: string) => {
      quoted.push(sessionId);
      return `reply from ${sessionId.slice(0, 8)}`;
    };
    const done = run(
      { targets: ["lead"], once: true },
      deps(lines, client, { readLastState, summaryDelayMs: 40, pollMs: 60_000 }),
    );
    await new Promise((r) => setTimeout(r, 20));
    herdr.push({ agent: "claude", agent_status: "done", pane_id: "w1:p1", workspace_id: "w1" });
    await new Promise((r) => setTimeout(r, 10)); // the stop's identity is read in this window
    stopped = true;
    await done;
    expect(quoted).toEqual([SESSION]);
    expect(lines.at(-1)).toContain('last: "reply from 11111111" (session 11111111)');
  });

  it("never runs polls on top of each other", async () => {
    await writeTranscript();
    await fakeHerdr();
    let calls = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    // every lookup after the first is slower than the 5ms poll interval
    const client = {
      agentGet: async () => {
        if (++calls === 1) return AGENT;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 25));
        inFlight -= 1;
        return AGENT;
      },
    };
    const done = run({ targets: ["lead"] }, deps([], client, { pollMs: 5 }));
    await new Promise((r) => setTimeout(r, 150));
    herdrSocket!.end();
    await done;
    expect(calls).toBeGreaterThan(3); // polls kept coming...
    expect(maxInFlight).toBe(1); // ...but one at a time
  });

  it("reports a stop exactly once when slow polls straddle it", async () => {
    await writeTranscript();
    await fakeHerdr();
    const lines: string[] = [];
    let calls = 0;
    const client = {
      agentGet: async () => {
        const n = ++calls;
        if (n === 1) return AGENT;
        await new Promise((r) => setTimeout(r, 25));
        return n >= 3 ? { ...AGENT, status: "done" as const } : AGENT;
      },
    };
    const done = run({ targets: ["lead"] }, deps(lines, client, { pollMs: 5 }));
    await new Promise((r) => setTimeout(r, 250));
    herdrSocket!.end();
    await done;
    expect(lines.filter((l) => l.startsWith("[lead] done"))).toHaveLength(1);
  });

  it("never lets a slow poll overwrite a newer socket event", async () => {
    await writeTranscript();
    const herdr = await fakeHerdr();
    const lines: string[] = [];
    let calls = 0;
    // after the first lookup, every poll answers "working" - but slowly, so the
    // socket's "done" lands while the poll is in flight
    const client = {
      agentGet: async () => {
        if (++calls === 1) return AGENT;
        await new Promise((r) => setTimeout(r, 30));
        return AGENT;
      },
    };
    const done = run({ targets: ["lead"], verbose: true }, deps(lines, client, { pollMs: 1000 }));
    await new Promise((r) => setTimeout(r, 10));
    herdr.push({ agent: "claude", agent_status: "done", pane_id: "w1:p1", workspace_id: "w1" });
    await new Promise((r) => setTimeout(r, 120));
    herdr.drop();
    await done;
    const statusLines = lines.filter((l) => !l.includes("watching") && !l.startsWith("[watch]"));
    expect(statusLines).toHaveLength(1);
    expect(statusLines[0]).toMatch(/^\[lead\] done/); // no stale "working again" after it
  });

  it("reports a target that disappears from herdr between polls", async () => {
    await writeTranscript();
    await fakeHerdr();
    const lines: string[] = [];
    let calls = 0;
    const client = {
      agentGet: async () => {
        if (++calls > 1) throw new HerdrError("agent_not_found", "gone");
        return AGENT;
      },
    };
    expect(await run({ targets: ["lead"] }, deps(lines, client))).toBe(0);
    expect(lines.at(-1)).toBe("[lead] gone - no longer running in herdr (pane closed or agent exited)");
  });

  it("says so and exits 1 when herdr's event stream drops", async () => {
    await writeTranscript();
    const herdr = await fakeHerdr();
    const lines: string[] = [];
    const done = run({ targets: ["lead"] }, deps(lines));
    herdr.drop();
    expect(await done).toBe(1);
    expect(lines.at(-1)).toMatch(/^\[watch\] lost herdr's event stream - .*Re-arm the watch once herdr is back\.$/);
  });

  it("exits 1 with a line when herdr's socket isn't there", async () => {
    await writeTranscript();
    const lines: string[] = [];
    expect(await run({ targets: ["lead"] }, deps(lines))).toBe(1);
    expect(lines.at(-1)).toContain("[watch] could not subscribe to herdr events");
  });

  it("fails fast with exit 2 on a target herdr can't resolve", async () => {
    const lines: string[] = [];
    const client = {
      agentGet: async () => {
        throw new HerdrError("agent_not_found", "agent target nope not found");
      },
    };
    expect(await run({ targets: ["nope"] }, deps(lines, client))).toBe(2);
    expect(lines).toEqual(["[nope] not found - agent target nope not found"]);
  });
});
