// parseSessionPreview: pure jsonl-text -> { preview, messageCount } | null.
// Null means "no parseable jsonl object lines at all" - the caller treats the
// file as malformed and skips it (DW-3.3).
//
// Line shapes handled (verified against the real ~/.claude/projects store
// during phase-3 discovery, read-only):
//   {"type":"summary","summary":"..."}                -> preferred preview
//   {"type":"user","message":{"content":...}}         -> fallback preview; counted
//   {"type":"assistant","message":{...}}              -> counted
// `content` may be a plain string or an array of {type:"text",text} blocks.
// Unrecognized or unparseable lines are skipped, never a crash.

const PREVIEW_MAX_CHARS = 120;

export interface SessionPreview {
  preview: string;
  messageCount: number;
}

export function parseSessionPreview(text: string): SessionPreview | null {
  let sawRecord = false;
  let summary: string | null = null;
  let firstUserText: string | null = null;
  let messageCount = 0;

  for (const line of text.split("\n")) {
    const record = parseRecord(line);
    if (!record) continue;
    sawRecord = true;
    if (record.type === "summary" && typeof record.summary === "string" && summary === null) {
      summary = record.summary;
    }
    if (record.type === "user" || record.type === "assistant") messageCount += 1;
    if (record.type === "user" && firstUserText === null) {
      firstUserText = messageText(record.message);
    }
  }

  if (!sawRecord) return null;
  return { preview: clip(summary ?? firstUserText ?? ""), messageCount };
}

/** One trimmed jsonl line -> its object form, or null for empty/malformed/non-object lines. */
function parseRecord(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null; // malformed line: skip, never crash (DW-3.3)
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

/** First text of a user message: string content, or the first {type:"text"} block. */
function messageText(message: unknown): string | null {
  if (typeof message !== "object" || message === null) return null;
  const content = (message as Record<string, unknown>).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        typeof block === "object" &&
        block !== null &&
        (block as Record<string, unknown>).type === "text" &&
        typeof (block as Record<string, unknown>).text === "string"
      ) {
        return (block as Record<string, unknown>).text as string;
      }
    }
  }
  return null;
}

/** Whitespace-collapsed, at most PREVIEW_MAX_CHARS chars (ellipsis-terminated when cut). */
function clip(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  return collapsed.length <= PREVIEW_MAX_CHARS ? collapsed : `${collapsed.slice(0, PREVIEW_MAX_CHARS - 1)}…`;
}
