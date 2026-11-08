// events.ts: a client for herdr's socket event stream (`events.subscribe`).
// herdr's CLI has no streaming command, so this speaks the socket protocol
// directly: newline-delimited JSON over the unix socket the server listens
// on. One request subscribes; the server answers `subscription_started` and
// then pushes one `{event, data}` line per matching event for as long as the
// connection stays open.
//
// Verified against herdr 0.9.0 (protocol 22): an agent finishing its turn
// arrives as `pane.agent_status_changed` with `agent_status: "done"`.
//
// Failure is always loud and always typed: a refused connection, an error
// response, or a stream that ends are HerdrErrors / an onClose call - never
// a silent stall, because a watcher that stops hearing events must say so.

import { connect, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { HerdrError } from "./types.js";

/** The event subscriptions herderp uses (herdr's schema has more). */
export type HerdrSubscription = { type: "pane.agent_status_changed"; pane_id: string };

/** One pushed event: `event` is the subscription kind, `data` its payload. */
export interface HerdrEvent {
  event: string;
  data: Record<string, unknown>;
}

export interface EventStream {
  /** Close the connection. onClose is not called for a deliberate close. */
  close(): void;
}

export interface SubscribeOptions {
  socketPath: string;
  subscriptions: HerdrSubscription[];
  onEvent: (event: HerdrEvent) => void;
  /** Called once if the stream ends or errors after it started. */
  onClose: (reason: string) => void;
}

/** The local herdr server's socket: $HERDR_SOCKET_PATH, else herdr's default. */
export function defaultSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.HERDR_SOCKET_PATH || join(homedir(), ".config", "herdr", "herdr.sock");
}

const SUBSCRIBE_ID = "herderp-watch";

/**
 * Open the socket and subscribe. Resolves once herdr confirms the
 * subscription; rejects with a HerdrError if the socket can't be reached or
 * herdr refuses the request. After that, events flow to onEvent until the
 * stream ends (onClose) or close() is called.
 */
export function subscribeEvents(options: SubscribeOptions): Promise<EventStream> {
  const { socketPath, subscriptions, onEvent, onClose } = options;
  return new Promise((resolve, reject) => {
    const socket: Socket = connect(socketPath);
    let started = false;
    let closedByUs = false;
    let buffer = "";

    const fail = (error: HerdrError) => {
      if (!started) {
        reject(error);
        socket.destroy();
      } else if (!closedByUs) {
        closedByUs = true; // report once
        onClose(error.message);
        socket.destroy();
      }
    };

    socket.on("connect", () => {
      const request = { id: SUBSCRIBE_ID, method: "events.subscribe", params: { subscriptions } };
      socket.write(`${JSON.stringify(request)}\n`);
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line === "") continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue; // a malformed line is skipped, never fatal
        }
        // valid JSON that isn't an object (null, a number, an array) is just as unusable
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
        const message = parsed as Record<string, unknown>;
        if (!started) {
          const error = message.error as { code?: unknown; message?: unknown } | undefined;
          if (error) {
            fail(new HerdrError(String(error.code ?? "subscribe_failed"), String(error.message ?? "subscribe failed")));
            return;
          }
          if ((message.result as { type?: unknown } | undefined)?.type === "subscription_started") {
            started = true;
            resolve({
              close: () => {
                closedByUs = true;
                socket.destroy();
              },
            });
          }
          continue;
        }
        if (typeof message.event === "string" && typeof message.data === "object" && message.data !== null) {
          onEvent({ event: message.event, data: message.data as Record<string, unknown> });
        }
      }
    });

    socket.on("error", (error) => {
      fail(new HerdrError("socket_unreachable", `herdr socket ${socketPath}: ${error.message}`, { cause: error }));
    });
    socket.on("close", () => {
      fail(new HerdrError("stream_closed", `herdr event stream ${socketPath} closed`));
    });
  });
}
