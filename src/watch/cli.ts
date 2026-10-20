// cli.ts: entry point for `herderp watch` - meant to be run by Claude Code's
// Monitor tool, which turns each stdout line into a notification. The exact
// command line comes from herdr_agent{action:"watch"}; see run.ts for the
// behavior and exit codes.
//
// Usage: bun run cli.ts <target>... [--stall 10m] [--once] [--json] [--verbose] [--poll 15s]

import { homedir } from "node:os";
import { join } from "node:path";
import { createHerdrClient } from "../herdr/client.js";
import { defaultSocketPath } from "../herdr/events.js";
import { createNecromancy } from "../necromancy/core.js";
import { runWatch, type RunWatchOptions } from "./run.js";
import { parseDuration } from "./watcher.js";

const USAGE = "usage: herderp watch <target>... [--stall 10m] [--once] [--json] [--verbose] [--poll 15s]";

export function parseArgs(argv: string[]): (RunWatchOptions & { pollMs?: number }) | string {
  const options: RunWatchOptions & { pollMs?: number } = { targets: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--once") options.once = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--verbose") options.verbose = true;
    else if (arg === "--stall" || arg === "--poll") {
      const ms = parseDuration(argv[++i] ?? "");
      if (ms === null) return `${arg} needs a duration like 90s, 10m, or 1h`;
      if (arg === "--stall") options.stallMs = ms;
      else options.pollMs = ms;
    } else if (arg.startsWith("--")) return `unknown option ${arg}`;
    else options.targets.push(arg);
  }
  return options.targets.length > 0 ? options : "name at least one agent (name or pane id) to watch";
}

if (import.meta.main) {
  const parsed = parseArgs(process.argv.slice(2));
  if (typeof parsed === "string") {
    process.stderr.write(`${parsed}\n${USAGE}\n`);
    process.exit(2);
  }
  const client = createHerdrClient();
  const projectsRoot = join(homedir(), ".claude", "projects");
  const necromancy = createNecromancy({ client, projectsRoot });
  const code = await runWatch(parsed, {
    client,
    socketPath: defaultSocketPath(),
    projectsRoot,
    pollMs: parsed.pollMs,
    // Write straight to the fd: Monitor needs each line the moment it happens.
    write: (line) => process.stdout.write(`${line}\n`),
    readLastState: async (sessionId, cwd) => (await necromancy.sessionAnchors({ sessionId, cwd })).lastState?.text,
  });
  process.exit(code);
}
