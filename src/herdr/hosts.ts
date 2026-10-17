// HostRegistry: named remote herdr servers, reached by running THAT
// machine's own `herdr` binary over ssh.
//
// Why ssh-exec rather than forwarding the remote Unix socket: the local
// binary would then speak to a server it may not match (verified live: this
// Mac runs herdr 0.7.5/protocol 17, a tailnet peer runs 0.7.3/protocol 16),
// and something would have to babysit a long-lived `ssh -L` process. Running
// the remote binary needs neither - every call is one stateless ssh exec, the
// remote pair is always version-matched, and herdr's `--remote` flag (which
// only attaches the interactive TUI, rejected on every API subcommand) never
// enters the picture.
//
// Invariants this module upholds:
//   - The registry file is re-read on every call, so an edit takes effect
//     without restarting the MCP server. A missing file is an empty
//     registry, never an error; a malformed one is `invalid_hosts_file`.
//   - Every argv element crosses the ssh boundary single-quoted, so a prompt
//     containing spaces, quotes, `$` or `;` reaches the remote herdr as one
//     argument, verbatim.
//   - ssh runs with BatchMode so it can never block the MCP server on a
//     password prompt, and its own failures (exit 255) surface as
//     `host_unreachable`, not as a herdr command failure.
//   - herdr's exit status travels IN-BAND, as a trailer the remote shell
//     prints after the command, and is stripped before the client sees
//     stdout. Verified live: Tailscale SSH reports exit 0 for a remote
//     command that exited 1 (`ssh ska 'exit 3'` -> 0), while OpenSSH's sshd
//     passes 3 through. Without the trailer every herdr error on a tailnet
//     host collapsed into `invalid_response` with an empty body.
//   - `local` is reserved: `clientFor()` / `clientFor("local")` return the
//     local client, and the name cannot be registered.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHerdrClient } from "./client.js";
import type { HerdrClient, HerdrRunResult, HerdrRunner } from "./client.js";
import { HerdrError } from "./types.js";
import type { Session } from "./types.js";

/** One registered host. `ssh` is the destination as ssh takes it (a
 * hostname, IP, or `user@host`); `user` is passed as `-l` and exists for
 * usernames ssh would mis-split on `@` (an email-shaped macOS account, say).
 * `herdr` is the remote binary path when it is not on the non-interactive
 * PATH; `socket` selects a non-default remote server via HERDR_SOCKET_PATH. */
export interface HostEntry {
  ssh: string;
  user?: string;
  herdr?: string;
  socket?: string;
}

export interface HostRecord extends HostEntry {
  name: string;
}

export interface HostCheck extends HostRecord {
  version: string;
  sessions: Session[];
}

/** The seam tools depend on: resolve an optional host name to a client. */
export interface ClientResolver {
  clientFor(host?: string): Promise<HerdrClient>;
}

export interface HostRegistry extends ClientResolver {
  /** Absolute path of the registry file. */
  readonly path: string;
  list(): Promise<HostRecord[]>;
  get(name: string): Promise<HostRecord>;
  add(name: string, entry: HostEntry): Promise<HostRecord>;
  remove(name: string): Promise<void>;
  /** Proves a host end to end: ssh in, run `herdr --version`, list sessions. */
  check(name: string): Promise<HostCheck>;
}

/** Runs one local process (ssh, here). Swappable for tests. */
export type SpawnFn = (argv: string[]) => Promise<HerdrRunResult>;

export interface HostRegistryOptions {
  /** Registry file. Default: $HERDERP_HOSTS_PATH, else ~/.config/herderp/hosts.json. */
  path?: string;
  /** Client for the local server. Default: a fresh `createHerdrClient()`. */
  localClient?: HerdrClient;
  /** Process runner for ssh. Default: Bun.spawn. */
  spawn?: SpawnFn;
  /** The ssh executable. Default: "ssh". Tests point it at a fake. */
  sshCommand?: string;
}

export const LOCAL_HOST = "local";
export const HOSTS_PATH_ENV = "HERDERP_HOSTS_PATH";
/** Host names: a filename-safe token, so they read cleanly in tool calls. */
const HOST_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
/** Remote PATH prefix: herdr's own installer puts it in ~/.local/bin, and
 * Homebrew in /opt/homebrew/bin - neither is on a non-interactive ssh PATH by
 * default (verified live on macOS). Left unquoted so the REMOTE shell expands
 * `$HOME`/`$PATH`; an explicit `herdr` entry bypasses the lookup entirely. */
const REMOTE_PATH = 'PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"';
const SSH_UNREACHABLE_EXIT = 255;
/** Printed by the remote shell after herdr exits, carrying `$?`. The leading
 * newline keeps it off herdr's last line even when that line is unterminated;
 * `parseExitTrailer` removes exactly what was added. */
export const EXIT_TRAILER = "__herderp_exit__:";
const EXIT_TRAILER_RE = /\n__herderp_exit__:(\d+)\n$/;

export function defaultHostsPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[HOSTS_PATH_ENV];
  if (override) return override;
  return path.join(os.homedir(), ".config", "herderp", "hosts.json");
}

/** POSIX single-quoting: safe for any byte sequence, including quotes. */
export function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** The exact local argv that runs `herdr <argv>` on `entry`'s machine. */
export function sshArgv(entry: HostEntry, argv: string[], sshCommand = "ssh"): string[] {
  const remote = [
    "env",
    REMOTE_PATH,
    ...(entry.socket !== undefined ? [shellQuote(`HERDR_SOCKET_PATH=${entry.socket}`)] : []),
    shellQuote(entry.herdr ?? "herdr"),
    ...argv.map(shellQuote),
    // `;` not `&&`: the trailer must print on failure too. `$?` is the
    // herdr exit status because nothing runs in between.
    `; printf '\\n${EXIT_TRAILER}%s\\n' "$?"`,
  ].join(" ");
  return [
    sshCommand,
    "-n",
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=10",
    ...(entry.user !== undefined ? ["-l", entry.user] : []),
    entry.ssh,
    remote,
  ];
}

/** Splits the exit trailer off stdout. Returns the ssh exit code untouched
 * when no trailer is present (ssh never ran the command, or the remote
 * shell is not POSIX - either way the real status is unknowable here). */
export function parseExitTrailer(stdout: string, fallbackExit: number): { stdout: string; exitCode: number } {
  const match = EXIT_TRAILER_RE.exec(stdout);
  if (match === null) return { stdout, exitCode: fallbackExit };
  return { stdout: stdout.slice(0, match.index), exitCode: Number(match[1]) };
}

/** A HerdrRunner whose every invocation is one ssh exec on the host. */
export function createSshRunner(name: string, entry: HostEntry, spawn: SpawnFn, sshCommand = "ssh"): HerdrRunner {
  return async (argv) => {
    const raw = await spawn(sshArgv(entry, argv, sshCommand));
    const outcome = raw.exitCode === SSH_UNREACHABLE_EXIT ? raw : { ...raw, ...parseExitTrailer(raw.stdout, raw.exitCode) };
    // ssh's first-contact notice lands on stderr ahead of whatever herdr
    // wrote there; left in place it would hide herdr's JSON error envelope
    // from the client's parser on that one call.
    const stderr = outcome.stderr
      .split("\n")
      .filter((line) => !line.startsWith("Warning: Permanently added "))
      .join("\n");
    if (outcome.exitCode === SSH_UNREACHABLE_EXIT) {
      throw new HerdrError(
        "host_unreachable",
        `host "${name}" (${entry.ssh}): ${stderr.trim() || "ssh failed with exit 255"}`,
      );
    }
    return { ...outcome, stderr };
  };
}

async function bunSpawn(argv: string[]): Promise<HerdrRunResult> {
  const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(raw: Record<string, unknown>, key: string, name: string, file: string): string | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value === "") {
    throw new HerdrError("invalid_hosts_file", `${file}: host "${name}" field "${key}" must be a non-empty string`);
  }
  return value;
}

/** Normalizes one registry entry: the `"user@host"` string shorthand or the
 * full object form. Validates shape, never trusts it. */
function parseEntry(name: string, raw: unknown, file: string): HostEntry {
  if (typeof raw === "string") {
    if (raw === "") throw new HerdrError("invalid_hosts_file", `${file}: host "${name}" has an empty ssh target`);
    return { ssh: raw };
  }
  if (!isRecord(raw)) {
    throw new HerdrError("invalid_hosts_file", `${file}: host "${name}" must be a string or an object`);
  }
  const ssh = optionalString(raw, "ssh", name, file);
  if (ssh === undefined) throw new HerdrError("invalid_hosts_file", `${file}: host "${name}" is missing "ssh"`);
  const entry: HostEntry = { ssh };
  const user = optionalString(raw, "user", name, file);
  const herdr = optionalString(raw, "herdr", name, file);
  const socket = optionalString(raw, "socket", name, file);
  if (user !== undefined) entry.user = user;
  if (herdr !== undefined) entry.herdr = herdr;
  if (socket !== undefined) entry.socket = socket;
  return entry;
}

export function validateHostName(name: string): string {
  if (!HOST_NAME.test(name)) {
    throw new HerdrError(
      "invalid_host_name",
      `host name "${name}" must be letters, digits, ".", "_" or "-" and start with a letter or digit`,
    );
  }
  if (name === LOCAL_HOST) {
    throw new HerdrError("invalid_host_name", `"${LOCAL_HOST}" is reserved for this machine's own herdr server`);
  }
  return name;
}

/** Validates an entry supplied by a caller (not the file) before it is stored. */
export function validateHostEntry(entry: HostEntry): HostEntry {
  const check = (key: keyof HostEntry, value: string | undefined, required: boolean) => {
    if (value === undefined) {
      if (required) throw new HerdrError("invalid_host_entry", `host entry is missing "${key}"`);
      return;
    }
    if (value === "" || value.includes("\n") || value.includes("\0")) {
      throw new HerdrError("invalid_host_entry", `host entry field "${key}" must be a single non-empty line`);
    }
    if (key === "ssh" && value.startsWith("-")) {
      throw new HerdrError("invalid_host_entry", `host entry "ssh" must not start with "-"`);
    }
  };
  check("ssh", entry.ssh, true);
  check("user", entry.user, false);
  check("herdr", entry.herdr, false);
  check("socket", entry.socket, false);
  const clean: HostEntry = { ssh: entry.ssh };
  if (entry.user !== undefined) clean.user = entry.user;
  if (entry.herdr !== undefined) clean.herdr = entry.herdr;
  if (entry.socket !== undefined) clean.socket = entry.socket;
  return clean;
}

function isEnoent(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

/** Builds the registry. See `HostRegistryOptions` for the injectable seams. */
export function createHostRegistry(options: HostRegistryOptions = {}): HostRegistry {
  const file = options.path ?? defaultHostsPath();
  const spawn = options.spawn ?? bunSpawn;
  const sshCommand = options.sshCommand ?? "ssh";
  let localClient = options.localClient;

  async function readHosts(): Promise<Record<string, HostEntry>> {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if (isEnoent(error)) return {};
      throw new HerdrError("invalid_hosts_file", `${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new HerdrError("invalid_hosts_file", `${file}: not valid JSON (${error instanceof Error ? error.message : String(error)})`);
    }
    if (!isRecord(parsed) || (parsed.hosts !== undefined && !isRecord(parsed.hosts))) {
      throw new HerdrError("invalid_hosts_file", `${file}: expected {"hosts":{...}} at the top level`);
    }
    const hosts: Record<string, HostEntry> = {};
    for (const [name, raw] of Object.entries(parsed.hosts ?? {})) {
      validateHostName(name);
      hosts[name] = parseEntry(name, raw, file);
    }
    return hosts;
  }

  async function writeHosts(hosts: Record<string, HostEntry>): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify({ hosts }, null, 2)}\n`, "utf8");
  }

  async function lookup(name: string): Promise<HostRecord> {
    const hosts = await readHosts();
    const entry = hosts[name];
    if (entry === undefined) {
      const known = Object.keys(hosts);
      throw new HerdrError(
        "unknown_host",
        `unknown host "${name}"; ` +
          (known.length === 0
            ? `no hosts are registered in ${file} - add one with herdr_host{action:"add"}`
            : `known hosts: ${known.join(", ")} (or omit host for this machine)`),
      );
    }
    return { name, ...entry };
  }

  function remoteRunner(record: HostRecord): HerdrRunner {
    return createSshRunner(record.name, record, spawn, sshCommand);
  }

  return {
    path: file,

    async list() {
      const hosts = await readHosts();
      return Object.entries(hosts).map(([name, entry]) => ({ name, ...entry }));
    },

    get: lookup,

    async add(name, entry) {
      validateHostName(name);
      const clean = validateHostEntry(entry);
      const hosts = await readHosts();
      hosts[name] = clean;
      await writeHosts(hosts);
      return { name, ...clean };
    },

    async remove(name) {
      const hosts = await readHosts();
      if (!(name in hosts)) await lookup(name); // throws unknown_host with the known list
      delete hosts[name];
      await writeHosts(hosts);
    },

    async clientFor(host) {
      if (host === undefined || host === "" || host === LOCAL_HOST) {
        localClient ??= createHerdrClient();
        return localClient;
      }
      return createHerdrClient(remoteRunner(await lookup(host)));
    },

    async check(name) {
      const record = await lookup(name);
      const runner = remoteRunner(record);
      const outcome = await runner(["--version"]);
      if (outcome.exitCode !== 0) {
        throw new HerdrError(
          "command_failed",
          `host "${name}": herdr --version failed: ${outcome.stderr.trim() || outcome.stdout.trim() || `exit ${outcome.exitCode}`}`,
        );
      }
      const version = outcome.stdout.trim().replace(/^herdr\s+/, "");
      const sessions = await createHerdrClient(runner).sessionList();
      return { ...record, version, sessions };
    },
  };
}
