// Tests for the watch CLI's argument parsing (src/watch/cli.ts).

import { describe, expect, it } from "bun:test";
import { parseArgs } from "../../src/watch/cli.js";

describe("parseArgs", () => {
  it("collects targets and flags, parsing durations", () => {
    expect(parseArgs(["lead", "w1:p2", "--stall", "10m", "--once", "--json", "--verbose", "--poll", "5s"])).toEqual({
      targets: ["lead", "w1:p2"],
      stallMs: 600_000,
      once: true,
      json: true,
      verbose: true,
      pollMs: 5000,
    });
  });

  it("explains what is wrong instead of guessing", () => {
    expect(parseArgs([])).toContain("at least one agent");
    expect(parseArgs(["lead", "--stall"])).toContain("--stall needs a duration");
    expect(parseArgs(["lead", "--stall", "soon"])).toContain("--stall needs a duration");
    expect(parseArgs(["lead", "--loud"])).toBe("unknown option --loud");
  });
});
