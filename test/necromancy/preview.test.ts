// Unit tests for parseSessionPreview (src/necromancy/preview.ts) - the pure
// jsonl parsing half of DW-3.3 (preview + messageCount, malformed handling).

import { describe, expect, it } from "bun:test";
import { parseSessionPreview } from "../../src/necromancy/preview.js";

const jl = (value: unknown): string => `${JSON.stringify(value)}\n`;

describe("parseSessionPreview - DW-3.3 preview + messageCount", () => {
  it("DW_3_3_prefers_the_summary_line_over_user_text", () => {
    const text =
      jl({ type: "user", message: { content: "first user words" }, cwd: "/tmp/p" }) +
      jl({ type: "summary", summary: "Fixing the flux capacitor" }) +
      jl({ type: "assistant", message: { content: [{ type: "text", text: "on it" }] } });

    expect(parseSessionPreview(text)).toEqual({ preview: "Fixing the flux capacitor", messageCount: 2 });
  });

  it("DW_3_3_falls_back_to_the_first_user_message_string_content", () => {
    const text = jl({ type: "user", message: { content: "help me refactor" } });

    expect(parseSessionPreview(text)).toEqual({ preview: "help me refactor", messageCount: 1 });
  });

  it("DW_3_3_extracts_text_from_array_content_blocks", () => {
    const text = jl({
      type: "user",
      message: { content: [{ type: "tool_result", content: "x" }, { type: "text", text: "actual question" }] },
    });

    expect(parseSessionPreview(text)?.preview).toBe("actual question");
  });

  it("DW_3_3_collapses_whitespace_and_clips_the_preview_to_120_chars", () => {
    const long = `a  b\t\nc ${"x".repeat(300)}`;
    const result = parseSessionPreview(jl({ type: "summary", summary: long }));

    expect(result?.preview.length).toBe(120);
    expect(result?.preview.startsWith("a b c x")).toBe(true);
    expect(result?.preview.endsWith("…")).toBe(true);
  });

  it("DW_3_3_counts_only_user_and_assistant_lines_as_messages", () => {
    const text =
      jl({ type: "summary", summary: "s" }) +
      jl({ type: "user", message: { content: "q" } }) +
      jl({ type: "assistant", message: { content: "a" } }) +
      jl({ type: "user", message: { content: "q2" } }) +
      jl({ type: "file-history-snapshot", snapshot: {} });

    expect(parseSessionPreview(text)?.messageCount).toBe(3);
  });

  it("DW_3_3_returns_null_for_fully_malformed_or_empty_content", () => {
    expect(parseSessionPreview("")).toBeNull();
    expect(parseSessionPreview("not json at all\n{broken")).toBeNull();
    expect(parseSessionPreview("42\n\"just a string\"\n[1,2]\n")).toBeNull();
  });

  it("DW_3_3_skips_interleaved_malformed_lines_without_losing_valid_ones", () => {
    const text = `garbage line\n${jl({ type: "user", message: { content: "still here" } })}{half a line`;

    expect(parseSessionPreview(text)).toEqual({ preview: "still here", messageCount: 1 });
  });

  it("DW_3_3_yields_an_empty_preview_when_no_summary_or_user_text_exists", () => {
    const text = jl({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } });

    expect(parseSessionPreview(text)).toEqual({ preview: "", messageCount: 1 });
  });

  it("DW_3_3_later_user_message_supplies_the_preview_when_the_first_has_no_text", () => {
    const text =
      jl({ type: "user", message: { content: [{ type: "tool_result", content: "x" }] } }) +
      jl({ type: "user", message: { content: "the real ask" } });

    expect(parseSessionPreview(text)).toEqual({ preview: "the real ask", messageCount: 2 });
  });
});
