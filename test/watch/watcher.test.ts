// Unit tests for the pure watch state machine (src/watch/watcher.ts):
// which signals become events, with a fake clock throughout.

import { describe, expect, it } from "bun:test";
import { formatDuration, formatEvent, parseDuration, Watcher } from "../../src/watch/watcher.js";

const MIN = 60_000;
const lead = { label: "lead", paneId: "w1:p1", status: "working" as const };
const cap = { label: "cap", paneId: "w1:p2", status: "working" as const };

describe("Watcher - stop events", () => {
  it("reports a transition to done, with how long the agent worked", () => {
    const w = new Watcher([lead], 0);
    expect(w.status("w1:p1", "done", 12 * MIN)).toEqual([
      { type: "status", label: "lead", paneId: "w1:p1", status: "done", previous: "working", inPreviousMs: 12 * MIN },
    ]);
  });

  it("reports idle and blocked as stops too", () => {
    const w = new Watcher([lead, cap], 0);
    expect(w.status("w1:p1", "idle", 1)[0]).toMatchObject({ type: "status", status: "idle" });
    expect(w.status("w1:p2", "blocked", 1)[0]).toMatchObject({ type: "status", status: "blocked" });
  });

  it("stays silent on a repeated status and on a return to working", () => {
    const w = new Watcher([lead], 0);
    w.status("w1:p1", "done", 1);
    expect(w.status("w1:p1", "done", 2)).toEqual([]);
    expect(w.status("w1:p1", "working", 3)).toEqual([]);
  });

  it("reports the return to working only when verbose", () => {
    const w = new Watcher([{ ...lead, status: "done" }], 0, { verbose: true });
    expect(w.status("w1:p1", "working", 5)[0]).toMatchObject({ type: "status", status: "working", previous: "done" });
  });

  it("ignores panes it was not asked to watch", () => {
    const w = new Watcher([lead], 0);
    expect(w.status("w9:p9", "done", 1)).toEqual([]);
  });
});

describe("Watcher - stall detection", () => {
  it("is off unless stallMs is set", () => {
    const w = new Watcher([lead], 0);
    expect(w.tick(60 * MIN)).toEqual([]);
  });

  it("reports a working agent with no activity for stallMs, once per quiet spell", () => {
    const w = new Watcher([lead], 0, { stallMs: 10 * MIN });
    expect(w.tick(9 * MIN)).toEqual([]);
    expect(w.tick(10 * MIN)).toEqual([{ type: "stalled", label: "lead", paneId: "w1:p1", status: "working", quietMs: 10 * MIN }]);
    expect(w.tick(20 * MIN)).toEqual([]); // already reported
  });

  it("transcript activity resets the clock and re-arms the report", () => {
    const w = new Watcher([lead], 0, { stallMs: 10 * MIN });
    w.activity("w1:p1", 8 * MIN);
    expect(w.tick(15 * MIN)).toEqual([]);
    expect(w.tick(18 * MIN)).toHaveLength(1);
    w.activity("w1:p1", 19 * MIN);
    expect(w.tick(29 * MIN)).toHaveLength(1); // quiet again for 10m after the new activity
  });

  it("ignores activity older than what it already knows", () => {
    const w = new Watcher([lead], 0, { stallMs: 10 * MIN });
    w.activity("w1:p1", 5 * MIN);
    w.activity("w1:p1", 1 * MIN); // stale stat
    expect(w.tick(14 * MIN)).toEqual([]);
    expect(w.tick(15 * MIN)).toHaveLength(1);
  });

  it("never reports a stall for a target marked noStall (no transcript to watch)", () => {
    const w = new Watcher([{ ...lead, noStall: true }], 0, { stallMs: MIN });
    expect(w.tick(60 * MIN)).toEqual([]);
  });

  it("never reports a stopped agent as stalled - it is waiting, and already reported", () => {
    const w = new Watcher([lead], 0, { stallMs: 10 * MIN });
    w.status("w1:p1", "done", 1);
    expect(w.tick(60 * MIN)).toEqual([]);
  });
});

describe("Watcher - gone", () => {
  it("reports a vanished agent once and stops watching it", () => {
    const w = new Watcher([lead, cap], 0, { stallMs: MIN });
    expect(w.gone("w1:p1", "agent_not_found")).toEqual([{ type: "gone", label: "lead", paneId: "w1:p1", detail: "agent_not_found" }]);
    expect(w.gone("w1:p1", "again")).toEqual([]);
    expect(w.status("w1:p1", "done", 5)).toEqual([]);
    expect(w.livePaneIds()).toEqual(["w1:p2"]);
    expect(w.allGone()).toBe(false);
    w.gone("w1:p2", "closed");
    expect(w.allGone()).toBe(true);
  });
});

describe("formatting", () => {
  it("renders a stop with the last state and session", () => {
    const line = formatEvent(
      { type: "status", label: "lead", paneId: "w1:p1", status: "done", previous: "working", inPreviousMs: 12 * MIN },
      { lastState: "Shipped   0.12.0\nand verified.", sessionId: "ffd176d5-9fa2-4558-9530-12536f925eba" },
    );
    expect(line).toBe('[lead] done after 12m working - last: "Shipped 0.12.0 and verified." (session ffd176d5)');
  });

  it("says what blocked means", () => {
    const line = formatEvent({ type: "status", label: "cap", paneId: "p", status: "blocked", previous: "working", inPreviousMs: 30_000 });
    expect(line).toBe("[cap] blocked after 30s working - needs input (a permission prompt or a question)");
  });

  it("renders stalls and departures", () => {
    expect(formatEvent({ type: "stalled", label: "cap", paneId: "p", status: "working", quietMs: 75 * MIN })).toBe(
      "[cap] stalled - no activity for 1h15m while working",
    );
    expect(formatEvent({ type: "gone", label: "cap", paneId: "p", detail: "pane closed" })).toBe("[cap] gone - pane closed");
  });

  it("clips a long last state", () => {
    const line = formatEvent(
      { type: "status", label: "a", paneId: "p", status: "idle", previous: "done", inPreviousMs: 0 },
      { lastState: "x".repeat(500) },
    );
    expect(line).toContain(`"${"x".repeat(199)}…"`);
  });
});

describe("durations", () => {
  it("parses s/m/h/ms and plain numbers", () => {
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("10m")).toBe(600_000);
    expect(parseDuration("1.5h")).toBe(5_400_000);
    expect(parseDuration("2500")).toBe(2500);
    expect(parseDuration("soon")).toBeNull();
    expect(parseDuration("0m")).toBeNull();
  });

  it("formats coarsely", () => {
    expect(formatDuration(42_000)).toBe("42s");
    expect(formatDuration(5 * MIN)).toBe("5m");
    expect(formatDuration(120 * MIN)).toBe("2h");
  });
});
