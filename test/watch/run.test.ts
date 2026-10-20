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

  it("turns stall detection off for a target with no transcript, and says so", async () => {
    await fakeHerdr();
    const lines: string[] = [];
    const done = run({ targets: ["lead"], stallMs: 1 }, deps(lines, {}, { pollMs: 5 }));
    await new Promise((r) => setTimeout(r, 60));
    expect(lines).toEqual(["[lead] watching - currently working (session 11111111) - no transcript found, stall detection off"]);
    herdrSocket!.end(); // end the watch
    expect(await done).toBe(1);
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
