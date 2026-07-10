// Unit tests for the session-reader core (src/necromancy/reader.ts) and its
// factory wiring in src/necromancy/core.ts - DW-1.1 through DW-1.7.
// Pure-function tests (parseTurns/outlineTurns/searchTurns/readTurns) build
// jsonl by hand, same style as preview.test.ts. Factory-method tests
// (sessionOutline/sessionSearch/sessionRead) use a per-test mkdtemp fixture
// dir as projectsRoot, same style as core.test.ts.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createNecromancy,
  deriveSlug,
  NecromancyError,
  type NecromancyOptions,
} from "../../src/necromancy/core.js";
import { outlineTurns, parseTurns, readTurns, searchTurns, type Turn } from "../../src/necromancy/reader.js";
import type { HerdrClient } from "../../src/herdr/client.js";

const jl = (value: unknown): string => `${JSON.stringify(value)}\n`;
const U1 = "11111111-1111-1111-1111-111111111111";

function stubClient(): HerdrClient {
  const unexpected = (name: string) => async () => {
    throw new Error(`unexpected herdr call: ${name}`);
  };
  return {
    agentList: unexpected("agentList"),
    agentGet: unexpected("agentGet"),
    agentRead: unexpected("agentRead"),
    agentWait: unexpected("agentWait"),
    workspaceList: unexpected("workspaceList"),
    workspaceCreate: unexpected("workspaceCreate"),
    workspaceFocus: unexpected("workspaceFocus"),
    paneRun: unexpected("paneRun"),
    paneClose: unexpected("paneClose"),
    sessionList: unexpected("sessionList"),
  } as HerdrClient;
}

// ---------------------------------------------------------------------------
// parseTurns - DW-1.1
// ---------------------------------------------------------------------------

describe("parseTurns - DW-1.1", () => {
  it("DW_1_1_parses_all_role_kinds_in_file_order", () => {
    const text =
      jl({ type: "user", message: { content: "hello there" } }) +
      jl({
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "let me think" },
            { type: "text", text: "here is my answer" },
            { type: "tool_use", id: "call_1", name: "Bash", input: { command: "ls" } },
          ],
        },
      }) +
      jl({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "call_1", content: "file1\nfile2" }] },
      });

    const turns = parseTurns(text);

    expect(turns.map((t) => t.role)).toEqual(["user", "thinking", "text", "tool_use", "tool_result"]);
    expect(turns.map((t) => t.index)).toEqual([0, 1, 2, 3, 4]);
    expect(turns[3]).toEqual({ index: 3, role: "tool_use", tool: "Bash", text: '{"command":"ls"}' });
    expect(turns[4]).toEqual({ index: 4, role: "tool_result", tool: "Bash", text: "file1\nfile2" });
  });

  it("DW_1_1_excludes_sidechain_and_meta_records", () => {
    const text =
      jl({ type: "summary", summary: "a summary" }) +
      jl({ type: "ai-title", title: "t" }) +
      jl({ type: "user", message: { content: "sidechain text" }, isSidechain: true }) +
      jl({ type: "user", message: { content: "real text" } }) +
      jl({ type: "file-history-snapshot", snapshot: {} });

    const turns = parseTurns(text);

    expect(turns).toHaveLength(1);
    expect(turns[0]).toEqual({ index: 0, role: "user", text: "real text" });
  });

  it("DW_1_1_skips_malformed_lines_without_crashing", () => {
    const text = `garbage\n${jl({ type: "user", message: { content: "kept" } })}{half a line\n`;

    expect(() => parseTurns(text)).not.toThrow();
    const turns = parseTurns(text);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.text).toBe("kept");
  });

  it("DW_1_1_handles_bare_string_and_block_array_content", () => {
    const text =
      jl({ type: "user", message: { content: "bare string" } }) +
      jl({ type: "assistant", message: { content: [{ type: "text", text: "block array" }] } });

    const turns = parseTurns(text);

    expect(turns.map((t) => t.text)).toEqual(["bare string", "block array"]);
  });

  it("DW_1_1_tool_result_with_unknown_tool_use_id_still_parses", () => {
    const text = jl({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "never-seen", content: "orphan result" }] },
    });

    const turns = parseTurns(text);

    expect(turns[0]).toEqual({ index: 0, role: "tool_result", tool: "unknown", text: "orphan result" });
  });

  it("DW_1_1_empty_text_returns_no_turns", () => {
    expect(parseTurns("")).toEqual([]);
  });

  it("DW_1_1_skips_valid_json_lines_that_are_not_objects", () => {
    // Valid JSON, but a number / string / array - not a record. Must be
    // skipped like a malformed line, never crash.
    const text = `42\n"just a string"\n[1,2,3]\n${jl({ type: "user", message: { content: "kept" } })}`;

    const turns = parseTurns(text);

    expect(turns).toHaveLength(1);
    expect(turns[0]!.text).toBe("kept");
  });

  it("DW_1_1_tool_result_content_as_block_array_is_joined", () => {
    // The common real-jsonl shape: tool_result.content is an array of
    // {type:"text",text} blocks, not a bare string.
    const text =
      jl({ type: "assistant", message: { content: [{ type: "tool_use", id: "c9", name: "Read", input: { file: "x" } }] } }) +
      jl({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "c9",
              content: [
                { type: "text", text: "line one" },
                { type: "image", source: {} },
                { type: "text", text: "line two" },
              ],
            },
          ],
        },
      });

    const turns = parseTurns(text);

    expect(turns[1]).toEqual({ index: 1, role: "tool_result", tool: "Read", text: "line one\nline two" });
  });

  it("DW_1_1_meta_record_carrying_a_message_object_is_still_excluded", () => {
    // A non-user/assistant record that nonetheless has a message object must
    // be dropped on the type check, not parsed for content.
    const text =
      jl({ type: "system", message: { content: "system noise" } }) +
      jl({ type: "user", message: { content: "real" } });

    const turns = parseTurns(text);

    expect(turns).toHaveLength(1);
    expect(turns[0]!.text).toBe("real");
  });
});

// ---------------------------------------------------------------------------
// outlineTurns - DW-1.2
// ---------------------------------------------------------------------------

function makeTurns(n: number, role: Turn["role"] = "user"): Turn[] {
  return Array.from({ length: n }, (_, i) => ({ index: i, role, text: `entry ${i}` }));
}

describe("outlineTurns - DW-1.2", () => {
  it("DW_1_2_outline_lists_index_role_tool_and_clipped_preview", () => {
    const turns: Turn[] = [
      { index: 0, role: "user", text: "hi" },
      { index: 1, role: "tool_use", tool: "Bash", text: "a".repeat(200) },
    ];

    const result = outlineTurns(turns);

    expect(result.entries[0]).toEqual({ index: 0, role: "user", preview: "hi" });
    expect(result.entries[1]!.tool).toBe("Bash");
    expect(result.entries[1]!.preview.length).toBeLessThanOrEqual(100);
    expect(result.entries[1]!.preview.endsWith("…")).toBe(true);
  });

  it("DW_1_2_filter_narrows_to_tool_use_only", () => {
    const turns: Turn[] = [
      { index: 0, role: "user", text: "q" },
      { index: 1, role: "tool_use", tool: "Bash", text: "ls" },
      { index: 2, role: "text", text: "a" },
      { index: 3, role: "tool_use", tool: "Read", text: "cat" },
    ];

    const result = outlineTurns(turns, { filter: "tool_use" });

    expect(result.entries.map((e) => e.index)).toEqual([1, 3]);
    expect(result.total).toBe(2);
  });

  it("DW_1_2_limit_and_offset_page_with_correct_total_and_nextOffset", () => {
    const turns = makeTurns(10);

    const page1 = outlineTurns(turns, { limit: 4, offset: 0 });
    expect(page1.entries.map((e) => e.index)).toEqual([0, 1, 2, 3]);
    expect(page1.total).toBe(10);
    expect(page1.nextOffset).toBe(4);

    const page3 = outlineTurns(turns, { limit: 4, offset: 8 });
    expect(page3.entries.map((e) => e.index)).toEqual([8, 9]);
    expect(page3.nextOffset).toBeNull();
  });

  it("DW_1_2_empty_turns_yields_empty_outline", () => {
    const result = outlineTurns([]);
    expect(result).toEqual({ entries: [], total: 0, nextOffset: null });
  });
});

// ---------------------------------------------------------------------------
// searchTurns - DW-1.3
// ---------------------------------------------------------------------------

describe("searchTurns - DW-1.3", () => {
  it("DW_1_3_case_insensitive_match_returns_index_role_tool_and_snippet", () => {
    const turns: Turn[] = [
      { index: 0, role: "user", text: "please FIX the Flux Capacitor" },
      { index: 1, role: "tool_use", tool: "Bash", text: "grep flux capacitor.ts" },
    ];

    const result = searchTurns(turns, "flux capacitor");

    expect(result.matches).toHaveLength(2);
    expect(result.matches[0]).toEqual({ index: 0, role: "user", snippet: "please FIX the Flux Capacitor" });
    expect(result.matches[1]!.tool).toBe("Bash");
    expect(result.truncated).toBe(false);
  });

  it("DW_1_3_limit_caps_results_and_sets_truncated", () => {
    const turns = makeTurns(5).map((t) => ({ ...t, text: "needle in here" }));

    const result = searchTurns(turns, "needle", { limit: 2 });

    expect(result.matches).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it("DW_1_3_no_match_returns_empty_not_truncated", () => {
    const turns = makeTurns(3);
    const result = searchTurns(turns, "nonexistent");
    expect(result).toEqual({ matches: [], truncated: false });
  });

  it("DW_1_3_regex_mode_matches_a_pattern", () => {
    const turns: Turn[] = [
      { index: 0, role: "user", text: "error code 404" },
      { index: 1, role: "user", text: "error code 500" },
      { index: 2, role: "user", text: "all good" },
    ];

    const result = searchTurns(turns, "error code \\d+", { regex: true });

    expect(result.matches.map((m) => m.index)).toEqual([0, 1]);
  });

  it("DW_1_3_invalid_regex_falls_back_without_crashing", () => {
    const turns: Turn[] = [{ index: 0, role: "user", text: "some(text" }];

    expect(() => searchTurns(turns, "(unterminated", { regex: true })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// readTurns - DW-1.4
// ---------------------------------------------------------------------------

describe("readTurns - DW-1.4", () => {
  it("DW_1_4_reads_verbatim_entries_in_range", () => {
    const turns = makeTurns(5);

    const result = readTurns(turns, { from: 1, to: 3 });

    expect(result.entries.map((e) => e.index)).toEqual([1, 2, 3]);
    expect(result.entries.map((e) => e.text)).toEqual(["entry 1", "entry 2", "entry 3"]);
    expect(result.truncated).toBe(false);
  });

  it("DW_1_4_span_cap_truncates_and_flags", () => {
    const turns = makeTurns(20);

    const result = readTurns(turns, { from: 0, to: 19, maxSpan: 5 });

    expect(result.entries.map((e) => e.index)).toEqual([0, 1, 2, 3, 4]);
    expect(result.truncated).toBe(true);
  });

  it("DW_1_4_byte_cap_truncates_and_flags", () => {
    const turns: Turn[] = [
      { index: 0, role: "user", text: "a".repeat(50) },
      { index: 1, role: "user", text: "b".repeat(50) },
      { index: 2, role: "user", text: "c".repeat(50) },
    ];

    const result = readTurns(turns, { from: 0, to: 2, maxBytes: 80 });

    expect(result.entries.map((e) => e.index)).toEqual([0, 1]);
    expect(result.truncated).toBe(true);
  });

  it("DW_1_4_a_single_entry_exceeding_the_byte_cap_is_truncated_in_place", () => {
    const turns: Turn[] = [{ index: 0, role: "user", text: "x".repeat(200) }];

    const result = readTurns(turns, { from: 0, to: 0, maxBytes: 50 });

    expect(result.entries).toHaveLength(1);
    expect(Buffer.byteLength(result.entries[0]!.text, "utf8")).toBeLessThanOrEqual(50);
    expect(result.truncated).toBe(true);
  });

  it("DW_1_4_exact_byte_fit_is_not_truncated", () => {
    // Two entries summing to exactly maxBytes: both included, no truncation.
    const turns: Turn[] = [
      { index: 0, role: "user", text: "a".repeat(40) },
      { index: 1, role: "user", text: "b".repeat(40) },
    ];

    const result = readTurns(turns, { from: 0, to: 1, maxBytes: 80 });

    expect(result.entries.map((e) => e.index)).toEqual([0, 1]);
    expect(result.truncated).toBe(false);
  });

  it("DW_1_4_exact_budget_exhaustion_then_next_entry_truncates", () => {
    // First entry fills the budget exactly; the loop's remaining<=0 branch
    // fires on the next iteration, flagging truncation with no partial slice.
    const turns: Turn[] = [
      { index: 0, role: "user", text: "a".repeat(40) },
      { index: 1, role: "user", text: "b".repeat(40) },
    ];

    const result = readTurns(turns, { from: 0, to: 1, maxBytes: 40 });

    expect(result.entries.map((e) => e.index)).toEqual([0]);
    expect(result.truncated).toBe(true);
  });

  it("DW_1_4_hard_byte_cap_holds_at_a_multibyte_boundary", () => {
    // The cap lands mid-emoji ("ab😀cd", the 4-byte 😀 spans bytes 2-5).
    // The returned text must be <= maxBytes AND must not introduce a U+FFFD
    // replacement char by decoding an orphaned lead byte.
    const turns: Turn[] = [{ index: 0, role: "user", text: "ab😀cd" }];

    const result = readTurns(turns, { from: 0, to: 0, maxBytes: 4 });

    expect(result.entries).toHaveLength(1);
    const text = result.entries[0]!.text;
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(4);
    expect(text).toBe("ab");
    expect(text.includes("�")).toBe(false);
    expect(result.truncated).toBe(true);
  });

  it("DW_1_4_to_less_than_from_is_empty_not_truncated", () => {
    const turns = makeTurns(5);
    expect(readTurns(turns, { from: 3, to: 1 })).toEqual({ entries: [], truncated: false });
  });

  it("DW_1_4_out_of_range_from_to_clamped", () => {
    const turns = makeTurns(3);

    const result = readTurns(turns, { from: -5, to: 999 });

    expect(result.entries.map((e) => e.index)).toEqual([0, 1, 2]);
  });

  it("DW_1_4_to_omitted_reads_a_single_entry", () => {
    const turns = makeTurns(3);
    const result = readTurns(turns, { from: 1 });
    expect(result.entries.map((e) => e.index)).toEqual([1]);
  });

  it("DW_1_4_empty_turns_yields_empty_read", () => {
    expect(readTurns([], { from: 0, to: 0 })).toEqual({ entries: [], truncated: false });
  });
});

// ---------------------------------------------------------------------------
// Factory methods (sessionOutline/sessionSearch/sessionRead) - DW-1.5/DW-1.6/DW-1.7
// ---------------------------------------------------------------------------

describe("necromancy session-reader factory methods (fixture FS)", () => {
  let root: string;
  const cwd = "/tmp/proj-a";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "necromancy-reader-test-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function makeSpace(): Promise<string> {
    const dir = join(root, deriveSlug(cwd));
    await mkdir(dir, { recursive: true });
    return dir;
  }

  async function writeSession(dir: string, id: string, content: string): Promise<void> {
    await writeFile(join(dir, `${id}.jsonl`), content);
  }

  function necromancy(overrides: Partial<NecromancyOptions> = {}) {
    return createNecromancy({ projectsRoot: root, client: stubClient(), ...overrides });
  }

  const sessionText =
    jl({ type: "user", message: { content: "first question about the bug" } }) +
    jl({ type: "assistant", message: { content: [{ type: "text", text: "investigating now" }] } }) +
    jl({ type: "assistant", message: { content: [{ type: "tool_use", id: "c1", name: "Bash", input: { command: "grep -r TODO" } }] } }) +
    jl({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "c1", content: "TODO: fix flux capacitor" }] } });

  describe("sessionOutline / sessionSearch / sessionRead happy paths", () => {
    it("sessionOutline returns entries for a real fixture session", async () => {
      const dir = await makeSpace();
      await writeSession(dir, U1, sessionText);
      const core = necromancy();

      const result = await core.sessionOutline({ sessionId: U1, cwd });

      expect(result.total).toBe(4);
      expect(result.entries.map((e) => e.role)).toEqual(["user", "text", "tool_use", "tool_result"]);
    });

    it("sessionSearch finds a lexical match in a real fixture session", async () => {
      const dir = await makeSpace();
      await writeSession(dir, U1, sessionText);
      const core = necromancy();

      const result = await core.sessionSearch({ sessionId: U1, cwd, query: "flux capacitor" });

      expect(result.matches).toHaveLength(1);
      expect(result.matches[0]!.tool).toBe("Bash");
    });

    it("sessionRead returns verbatim entries for a real fixture session", async () => {
      const dir = await makeSpace();
      await writeSession(dir, U1, sessionText);
      const core = necromancy();

      const result = await core.sessionRead({ sessionId: U1, cwd, from: 0, to: 1 });

      expect(result.entries.map((e) => e.text)).toEqual(["first question about the bug", "investigating now"]);
    });
  });

  describe("DW-1.5: barricade + not-found + size gate", () => {
    const maliciousIds = ["x; rm -rf ~", "$(whoami)", `${U1}\n`, "--help", ""];

    for (const method of ["sessionOutline", "sessionSearch", "sessionRead"] as const) {
      it(`DW_1_5_${method}_rejects_non_uuid_sessionId_before_any_read`, async () => {
        await makeSpace(); // space dir exists, but no session file - proves no read is attempted
        const core = necromancy();
        const callArgs =
          method === "sessionSearch"
            ? { query: "x" }
            : method === "sessionRead"
              ? { from: 0 }
              : {};

        for (const sessionId of maliciousIds) {
          const err = await (core[method] as (a: Record<string, unknown>) => Promise<unknown>)({
            sessionId,
            cwd,
            ...callArgs,
          }).catch((e: unknown) => e);

          expect(err).toBeInstanceOf(NecromancyError);
          expect((err as NecromancyError).code).toBe("invalid_session_id");
        }
      });

      it(`DW_1_5_${method}_absent_file_is_session_not_found`, async () => {
        await makeSpace();
        const core = necromancy();
        const callArgs =
          method === "sessionSearch"
            ? { query: "x" }
            : method === "sessionRead"
              ? { from: 0 }
              : {};

        const err = await (core[method] as (a: Record<string, unknown>) => Promise<unknown>)({
          sessionId: U1,
          cwd,
          ...callArgs,
        }).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(NecromancyError);
        expect((err as NecromancyError).code).toBe("session_not_found");
      });

      it(`DW_1_5_${method}_oversized_file_is_stat_gated_never_read`, async () => {
        const dir = await makeSpace();
        // Valid content, but over the injected cap - excluded by stat alone.
        await writeSession(dir, U1, jl({ type: "summary", summary: "x".repeat(500) }));
        const core = necromancy({ maxSessionBytes: 100 });
        const callArgs =
          method === "sessionSearch"
            ? { query: "x" }
            : method === "sessionRead"
              ? { from: 0 }
              : {};

        const err = await (core[method] as (a: Record<string, unknown>) => Promise<unknown>)({
          sessionId: U1,
          cwd,
          ...callArgs,
        }).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(NecromancyError);
        expect((err as NecromancyError).code).toBe("session_not_found");
      });
    }
  });

  describe("DW-1.6: caps sourced from NecromancyOptions, overridable", () => {
    it("DW_1_6_default_caps_apply_when_unspecified", async () => {
      const dir = await makeSpace();
      const manyTurns = Array.from({ length: 300 }, (_, i) =>
        jl({ type: "user", message: { content: `turn ${i}` } }),
      ).join("");
      await writeSession(dir, U1, manyTurns);
      const core = necromancy();

      const result = await core.sessionOutline({ sessionId: U1, cwd });

      expect(result.entries.length).toBe(200); // DEFAULT_MAX_OUTLINE_ENTRIES
      expect(result.nextOffset).toBe(200);
    });

    it("DW_1_6_caps_overridable_via_options", async () => {
      const dir = await makeSpace();
      const manyTurns = Array.from({ length: 10 }, (_, i) =>
        jl({ type: "user", message: { content: `turn ${i}` } }),
      ).join("");
      await writeSession(dir, U1, manyTurns);
      const core = necromancy({ maxOutlineEntries: 3 });

      const result = await core.sessionOutline({ sessionId: U1, cwd });

      expect(result.entries.length).toBe(3);
      expect(result.nextOffset).toBe(3);
    });

    it("DW_1_6_huge_session_response_never_exceeds_the_byte_cap", async () => {
      const dir = await makeSpace();
      const hugeTurns = Array.from({ length: 500 }, (_, i) =>
        jl({ type: "user", message: { content: `turn ${i} ${"z".repeat(2000)}` } }),
      ).join("");
      await writeSession(dir, U1, hugeTurns);
      const core = necromancy({ maxReadBytes: 4096, maxReadSpan: 1000 });

      const result = await core.sessionRead({ sessionId: U1, cwd, from: 0, to: 499 });

      const totalBytes = result.entries.reduce((sum, e) => sum + Buffer.byteLength(e.text, "utf8"), 0);
      expect(totalBytes).toBeLessThanOrEqual(4096);
      expect(result.truncated).toBe(true);
    });
  });
});
