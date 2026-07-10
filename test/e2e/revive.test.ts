// Live e2e proof for DW-4.3/DW-4.4 - the only test in the repo that talks to
// a real `herdr` process. Everything else (test/herdr/**, test/necromancy/**)
// stubs the runner/FS on purpose; this file exists specifically to prove the
// production code path (createHerdrClient + createNecromancy().revive) works
// against the real CLI, because that is exactly the gap a stub cannot catch
// (see the paneRun bug this suite's first live run surfaced, fixed in
// src/herdr/client.ts and regression-tested in test/herdr/client.test.ts).
//
// Guarded: the live-session describe block requires BOTH an explicit opt-in
// (`HERDERP_E2E_LIVE=1` in the environment) AND a running `herdr status`.
// herdr is normally running on dev machines, so gating on herdrUp alone would
// make a routine `bun test` silently spawn a real `claude` session and
// permanently litter `~/.claude/projects/` with transcripts this test cannot
// clean up (that's Claude Code's own state, outside this repo). Requiring the
// explicit flag keeps plain `bun test` fully side-effect-free by default,
// everywhere, regardless of whether herdr happens to be up.
//
// Run the live e2e explicitly with:
//   HERDERP_E2E_LIVE=1 bun test test/e2e/revive.test.ts
//
// The herdr-down / no-crash test (DW-4.4) does NOT depend on real herdr or
// the opt-in flag and always runs.
//
// Everything this file creates (temp cwd, workspace, pane, throwaway claude
// session) is cleaned up in a finally block, and nothing pre-existing is
// touched - a fresh workspace/pane is created for the test and closed again.

import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createHerdrClient, type HerdrRunner } from "../../src/herdr/client.js";
import { createNecromancy } from "../../src/necromancy/core.js";
import { HerdrError } from "../../src/herdr/types.js";

const MARKER = `NECRO-E2E-MARKER-${Date.now()}`;
const DETECT_TIMEOUT_MS = 45_000;
const POLL_MS = 1_000;

async function isHerdrUp(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["herdr", "status"], { stdout: "pipe", stderr: "pipe" });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

/** Polls `predicate` until it returns truthy or `timeoutMs` elapses. */
async function waitFor<T>(predicate: () => Promise<T | undefined>, timeoutMs: number): Promise<T | undefined> {
  for (let elapsed = 0; ; elapsed += POLL_MS) {
    const value = await predicate();
    if (value) return value;
    if (elapsed + POLL_MS > timeoutMs) return undefined;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

const liveOptIn = process.env.HERDERP_E2E_LIVE === "1";
const herdrUp = liveOptIn && (await isHerdrUp());

describe.skipIf(!herdrUp)("necromancy live e2e - DW-4.3 (requires HERDERP_E2E_LIVE=1 and a running herdr)", () => {
  it(
    "start -> kill -> revive: the same session id reattaches with prior context present",
    async () => {
      const client = createHerdrClient();
      let paneId: string | undefined;
      let workspaceId: string | undefined;
      let tempDir: string | undefined;

      try {
        tempDir = await mkdtemp(join(tmpdir(), "herderp-necro-e2e-"));
        // realpath: macOS resolves /tmp -> /private/tmp, and Claude Code's
        // on-disk graveyard slug is keyed off the *resolved* cwd - passing
        // the unresolved path would compute the wrong slug (verified live
        // during discovery: herdr's own workspace_created envelope echoed
        // back the resolved path, not the mkdtemp one).
        const cwd = await realpath(tempDir);

        const workspace = await client.workspaceCreate({ cwd, label: "necro-e2e-test", focus: false });
        workspaceId = workspace.id;
        paneId = workspace.rootPaneId;

        // Boot claude, then send one prompt - two separate `pane run` calls,
        // exactly mirroring the research doc's verified manual cycle.
        // `pane run` types into whatever is in the foreground; claude's TUI
        // self-registers with herdr (sessionId + "idle" status) within a
        // couple of seconds of boot, well before it has actually processed
        // any message, so a non-empty sessionId is NOT proof the prompt
        // landed. Verified live: a prompt typed too soon after boot can be
        // silently dropped by the still-initializing TUI. The robust signal
        // is `agent_status` transitioning to "working"/"done" - if it's
        // still "idle" a few seconds after sending, resend once.
        await client.paneRun(paneId, "claude");
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        await client.paneRun(paneId, `${MARKER} please just reply OK`);
        let lastSendAt = Date.now();

        let resent = false;
        const RESEND_AFTER_MS = 10_000;
        const detected = await waitFor(async () => {
          const agents = await client.agentList();
          const mine = agents.find((agent) => agent.cwd === cwd);
          if (mine?.status === "working" || mine?.status === "done") return mine;
          if (!resent && mine?.status === "idle" && Date.now() - lastSendAt >= RESEND_AFTER_MS) {
            resent = true;
            lastSendAt = Date.now();
            await client.paneRun(paneId!, `${MARKER} please just reply OK`);
          }
          return undefined;
        }, DETECT_TIMEOUT_MS);
        expect(detected, "herdr should detect the prompt actually being processed (status working/done)").toBeDefined();
        const sessionId = detected!.sessionId;
        expect(sessionId).not.toBe("");
        expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

        // Disk is authoritative (per the plan's design) - confirm the
        // graveyard file exists and actually holds the marker prompt before
        // killing anything.
        const slug = cwd.replace(/[/.]/g, "-");
        const sessionPath = join(homedir(), ".claude", "projects", slug, `${sessionId}.jsonl`);
        const beforeKill = await readFile(sessionPath, "utf8");
        expect(beforeKill).toContain(MARKER);

        // Kill: close the pane. Closing the last pane in a workspace
        // auto-closes the workspace too (verified) - clear both refs so
        // the finally block doesn't try to close an already-gone pane.
        await client.paneClose(paneId);
        paneId = undefined;
        workspaceId = undefined;

        await waitFor(async () => {
          const agents = await client.agentList();
          return agents.some((agent) => agent.sessionId === sessionId) ? undefined : true;
        }, 10_000);

        // The jsonl must survive the kill - it's the whole premise of
        // necromancy (dead sessions are revivable from disk).
        const afterKill = await readFile(sessionPath, "utf8");
        expect(afterKill).toContain(MARKER);

        // Now exercise the REAL production code path - not a stub, not the
        // raw CLI. This is what necromancy_revive does.
        const necromancy = createNecromancy({ client, detectTimeoutMs: DETECT_TIMEOUT_MS, pollIntervalMs: POLL_MS });
        const result = await necromancy.revive({ sessionId, cwd });

        expect(result.sessionId).toBe(sessionId);
        expect(result.detected, "herdr should re-detect the resumed session within the bounded wait").toBe(true);
        workspaceId = result.workspaceId;
        paneId = result.paneId;

        // Prior context present: the revived pane's recent output should
        // show the original marker prompt (and, since --resume replays the
        // transcript, its reply).
        const revivedOutput = await client.agentRead(paneId, { lines: 200 });
        expect(revivedOutput).toContain(MARKER);
      } finally {
        if (paneId) await client.paneClose(paneId).catch(() => {});
        if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    },
    90_000,
  );
});

describe("necromancy degraded environments - DW-4.4 (no live herdr required)", () => {
  function herdrDownRunner(): HerdrRunner {
    return async () => {
      throw new Error("connect ECONNREFUSED /Users/r/.config/herdr/herdr.sock");
    };
  }

  it("findSpaces surfaces a typed, readable error when herdr is unreachable - not a raw crash", async () => {
    const client = createHerdrClient(herdrDownRunner());
    const necromancy = createNecromancy({ client });

    const error = await necromancy.findSpaces().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HerdrError);
    expect((error as HerdrError).code).toBe("spawn_failed");
    expect((error as HerdrError).message).toContain("herdr");
    expect((error as HerdrError).message).not.toContain("undefined is not a function");
  });

  it("revive surfaces a typed, readable error when herdr is unreachable, after the disk-side gates pass", async () => {
    const projectsRoot = await mkdtemp(join(tmpdir(), "herderp-necro-degraded-"));
    try {
      const sessionId = "11111111-1111-1111-1111-111111111111";
      const cwd = "/tmp/wherever";
      const slug = cwd.replace(/[/.]/g, "-");
      await mkdir(join(projectsRoot, slug), { recursive: true });
      await writeFile(join(projectsRoot, slug, `${sessionId}.jsonl`), `${JSON.stringify({ type: "summary", summary: "x" })}\n`);

      const client = createHerdrClient(herdrDownRunner());
      const necromancy = createNecromancy({ client, projectsRoot });

      const error = await necromancy.revive({ sessionId, cwd }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(HerdrError);
      expect((error as HerdrError).code).toBe("spawn_failed");
    } finally {
      await rm(projectsRoot, { recursive: true, force: true });
    }
  });
});
