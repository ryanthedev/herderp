// Tests for the herdr socket event-stream client (src/herdr/events.ts)
// against a throwaway unix-socket server standing in for herdr - herdr
// itself is never spawned.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSocketPath, subscribeEvents, type HerdrEvent } from "../../src/herdr/events.js";
import { HerdrError } from "../../src/herdr/types.js";

let dir: string;
let socketPath: string;
let server: Server | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "herdr-events-"));
  socketPath = join(dir, "herdr.sock");
});

afterEach(async () => {
  server?.close();
  server = undefined;
  await rm(dir, { recursive: true, force: true });
});

/** A fake herdr: hands each connection and its first request line to `onRequest`. */
function fakeHerdr(onRequest: (socket: Socket, request: Record<string, unknown>) => void): Promise<void> {
  return new Promise((resolve) => {
    server = createServer((socket) => {
      let buf = "";
      socket.on("data", (d) => {
        buf += d.toString();
        const nl = buf.indexOf("\n");
        if (nl !== -1) onRequest(socket, JSON.parse(buf.slice(0, nl)));
      });
    });
    server.listen(socketPath, () => resolve());
  });
}

const statusLine = (pane_id: string, agent_status: string) =>
  `${JSON.stringify({ event: "pane.agent_status_changed", data: { agent: "claude", agent_status, pane_id, workspace_id: "w1" } })}\n`;

describe("subscribeEvents", () => {
  it("sends events.subscribe, resolves on subscription_started, then delivers events and reports the stream ending once", async () => {
    let request: Record<string, unknown> | undefined;
    await fakeHerdr((socket, req) => {
      request = req;
      socket.write(`${JSON.stringify({ id: req.id, result: { type: "subscription_started" } })}\n`);
      // two events split across writes, plus a junk line that must be skipped
      const both = statusLine("w1:p1", "working") + "not json\n" + statusLine("w1:p1", "done");
      socket.write(both.slice(0, 40));
      setTimeout(() => {
        socket.write(both.slice(40));
        setTimeout(() => socket.end(), 20);
      }, 20);
    });

    const events: HerdrEvent[] = [];
    const closes: string[] = [];
    const closed = new Promise<void>((resolve) => {
      void subscribeEvents({
        socketPath,
        subscriptions: [{ type: "pane.agent_status_changed", pane_id: "w1:p1" }],
        onEvent: (e) => events.push(e),
        onClose: (reason) => {
          closes.push(reason);
          resolve();
        },
      });
    });
    await closed;

    expect(request).toMatchObject({
      method: "events.subscribe",
      params: { subscriptions: [{ type: "pane.agent_status_changed", pane_id: "w1:p1" }] },
    });
    expect(events.map((e) => e.data.agent_status)).toEqual(["working", "done"]);
    expect(closes).toHaveLength(1);
    expect(closes[0]).toContain("closed");
  });

  it("does not call onClose after a deliberate close()", async () => {
    await fakeHerdr((socket, req) => socket.write(`${JSON.stringify({ id: req.id, result: { type: "subscription_started" } })}\n`));
    let closes = 0;
    const stream = await subscribeEvents({ socketPath, subscriptions: [], onEvent: () => {}, onClose: () => closes++ });
    stream.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(closes).toBe(0);
  });

  it("rejects with herdr's own error code when the subscription is refused", async () => {
    await fakeHerdr((socket, req) =>
      socket.write(`${JSON.stringify({ id: req.id, error: { code: "invalid_params", message: "unknown pane" } })}\n`),
    );
    const error = await subscribeEvents({ socketPath, subscriptions: [], onEvent: () => {}, onClose: () => {} }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HerdrError);
    expect((error as HerdrError).code).toBe("invalid_params");
  });

  it("rejects with socket_unreachable when nothing is listening", async () => {
    const error = await subscribeEvents({ socketPath, subscriptions: [], onEvent: () => {}, onClose: () => {} }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HerdrError);
    expect((error as HerdrError).code).toBe("socket_unreachable");
  });
});

describe("defaultSocketPath", () => {
  it("honors HERDR_SOCKET_PATH, else herdr's default under ~/.config", () => {
    expect(defaultSocketPath({ HERDR_SOCKET_PATH: "/tmp/x.sock" })).toBe("/tmp/x.sock");
    expect(defaultSocketPath({})).toMatch(/\.config\/herdr\/herdr\.sock$/);
  });
});
