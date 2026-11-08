// events.ts: herdr-core's live event stream, for the watcher.
//
// One long-lived `hc connect`, one `events.subscribe` (no filter: one
// subscription per connection, so the caller filters by address). The reply
// is a snapshot; after it the connection carries only notifications:
//   {"method":"event","params":{"type":"status","terminal":"t43","seq":N,"data":{...}}}
//   {"method":"heartbeat","params":{"seq":N}}   every ~15 s
// Event types seen live (2026-11-08): status (data.status, null once the
// program stops reporting), turn, foreground, labels, size (flaps - ignore),
// finished, plus lost/removed/restarted per the schema.
//
// The stream counts as lost when the process ends or no line (heartbeat
// included) arrives for HEARTBEAT_GRACE_MS; onClose then fires once.

import type { ConnectSpawn } from "./client.js";
import { CoreError } from "./types.js";

export interface CoreEvent {
  type: string;
  terminal: string;
  data: Record<string, unknown>;
}

export interface CoreEventStream {
  /** Close the connection. onClose is not called for a deliberate close. */
  close(): void;
}

export interface CoreSubscribeOptions {
  onEvent: (event: CoreEvent) => void;
  onClose: (reason: string) => void;
  /** The process to run; default `hc connect`. */
  command?: string[];
  spawn?: ConnectSpawn;
  /** No line for this long means the core went away. Default 45 s (three missed heartbeats). */
  heartbeatGraceMs?: number;
}

const HEARTBEAT_GRACE_MS = 45_000;
const SUBSCRIBE_ID = 1;

const defaultSpawn: ConnectSpawn = (argv) => {
  const proc = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  return {
    stdin: { write: (chunk) => proc.stdin.write(chunk), end: () => proc.stdin.end() },
    stdout: proc.stdout,
    stderr: proc.stderr,
    exited: proc.exited,
    kill: () => proc.kill(),
  };
};

/**
 * Subscribe. Resolves once the core answers the subscription; rejects with a
 * CoreError if it can't be started or refuses.
 */
export function subscribeCoreEvents(options: CoreSubscribeOptions): Promise<CoreEventStream> {
  const command = options.command ?? ["hc", "connect"];
  const spawn = options.spawn ?? defaultSpawn;
  const graceMs = options.heartbeatGraceMs ?? HEARTBEAT_GRACE_MS;

  return new Promise((resolve, reject) => {
    let proc: ReturnType<ConnectSpawn>;
    try {
      proc = spawn(command);
    } catch (cause) {
      reject(new CoreError("core_unreachable", `could not start \`${command.join(" ")}\`: ${String(cause)}`));
      return;
    }
    let started = false;
    let closed = false;
    let lastSeq = -1;
    let watchdog: ReturnType<typeof setTimeout> | undefined;

    const stop = () => {
      if (watchdog) clearTimeout(watchdog);
      try {
        proc.stdin.end();
      } catch {
        // already closed
      }
      proc.kill();
    };
    const fail = (error: CoreError) => {
      if (closed) return;
      closed = true;
      stop();
      if (!started) reject(error);
      else options.onClose(error.message);
    };
    const feed = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(
        () => fail(new CoreError("stream_closed", `herdr-core sent nothing for ${Math.round(graceMs / 1000)}s`)),
        graceMs,
      );
    };

    const handle = (message: Record<string, unknown>) => {
      if (!started) {
        if (message.id !== SUBSCRIBE_ID) return;
        if (isRecord(message.error)) {
          const data = isRecord(message.error.data) ? message.error.data : {};
          fail(new CoreError(typeof data.kind === "string" ? data.kind : "subscribe_failed", String(message.error.message ?? "subscribe failed")));
          return;
        }
        started = true;
        const result = isRecord(message.result) ? message.result : {};
        if (typeof result.seq === "number") lastSeq = result.seq; // events after the snapshot follow
        resolve({
          close: () => {
            closed = true;
            stop();
          },
        });
        return;
      }
      if (message.method !== "event" || !isRecord(message.params)) return;
      const { type, terminal, data, seq } = message.params;
      // Events arrive in seq order; one at or below the last seen is a replay
      // (after a `missed` re-sync) and must not undo a newer state.
      if (typeof seq === "number") {
        if (seq <= lastSeq) return;
        lastSeq = seq;
      }
      if (typeof terminal !== "string" && type === "missed" && isRecord(data) && typeof data.seq === "number") {
        lastSeq = Math.max(lastSeq, data.seq);
        return;
      }
      if (typeof type !== "string" || typeof terminal !== "string") return;
      options.onEvent({ type, terminal, data: isRecord(data) ? data : {} });
    };

    void (async () => {
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          feed();
          buffer += decoder.decode(value, { stream: true });
          let newline: number;
          while ((newline = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (line === "" || closed) continue;
            let parsed: unknown;
            try {
              parsed = JSON.parse(line);
            } catch {
              continue; // a malformed line is skipped, never fatal
            }
            if (isRecord(parsed)) handle(parsed);
          }
        }
      } catch {
        // fall through: the stream ended
      }
      fail(new CoreError("stream_closed", "herdr-core's event stream closed"));
    })();

    try {
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: SUBSCRIBE_ID, method: "events.subscribe", params: {} })}\n`);
      feed();
    } catch (cause) {
      fail(new CoreError("core_unreachable", `could not write to herdr-core: ${String(cause)}`));
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
