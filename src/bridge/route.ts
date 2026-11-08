// route.ts: which engine an id or a call belongs to. Pure functions only.
//
// herderp drives two engines that run side by side:
//   - "herdr": the herdr TUI server (`herdr` CLI, ~/.config/herdr/herdr.sock);
//   - "core":  herdr-core (`hc`), which runs the Herdr desktop app's terminals.
//
// Their ids never collide by shape (verified live 2026-11-08):
//   herdr  workspace `w8`, tab `w8:tD`, pane `w8:pG`, terminal `term_65f0...`
//   core   terminal `t3s` or `ska/t3s`, space `sp<32 hex>`, tab `tb<32 hex>`,
//          pane `p<32 hex>` (remote ones carry a `<machine>/` prefix)
// The one shape that can't be told apart is a bare word: `t3s` is a core
// address, but it is also a legal herdr agent name, and so is `review`. Those
// return null here and are looked up in both engines (see resolve.ts).

export type Engine = "herdr" | "core";

export const ENGINES: readonly Engine[] = ["herdr", "core"];

const HERDR_WORKSPACE_RE = /^w[0-9A-Za-z]+$/;
const HERDR_SUB_RE = /^w[0-9A-Za-z]+:[pt][0-9A-Za-z]+$/;
const HERDR_TERMINAL_RE = /^term_[0-9a-z]+$/;
const CORE_LAYOUT_RE = /^(?:[A-Za-z0-9._-]+\/)?(?:sp|tb|p)[0-9a-f]{32}$/;

/**
 * The engine an id belongs to by its shape alone, or null when its shape is
 * shared. `kind` matters: an agent target can be any name, so only shapes no
 * name takes decide it (`w8:pG`, `term_...`) - `wprobe` is a name, not a
 * herdr workspace id, and `api/fix` could be a herdr name as well as a core
 * `machine/name`, so both are looked up. Layout ids (workspace/space, tab,
 * pane) are never names, so their full shapes count, and a `machine/` prefix
 * there is core (herdr names hosts through `host`, never a prefix).
 */
export function engineOfId(id: string, kind: "agent" | "layout" = "agent"): Engine | null {
  const trimmed = id.trim();
  if (HERDR_SUB_RE.test(trimmed) || HERDR_TERMINAL_RE.test(trimmed)) return "herdr";
  if (kind === "layout") {
    if (CORE_LAYOUT_RE.test(trimmed) || trimmed.includes("/")) return "core";
    if (HERDR_WORKSPACE_RE.test(trimmed)) return "herdr";
  }
  return null;
}

/**
 * The engine the caller itself runs in, from its environment: a terminal
 * herdr-core started carries HC_TERMINAL_ID, a herdr pane HERDR_WORKSPACE_ID.
 * New things (a space, a tab, an agent) go here unless told otherwise.
 * Neither set: core, the engine the desktop app runs on.
 */
export function homeEngine(env: NodeJS.ProcessEnv = process.env): Engine {
  // herdr first: a herdr server started from a Herdr app terminal hands its
  // panes that terminal's HC_TERMINAL_ID too, and the innermost engine is herdr.
  if (env.HERDR_WORKSPACE_ID || env.HERDR_PANE_ID) return "herdr";
  if (env.HC_TERMINAL_ID) return "core";
  return "core";
}

/**
 * Picks the engine for a layout call (or one creating something): an explicit
 * `engine` wins; then the first layout id whose shape decides it; then a
 * remote `host`, which means herdr (herderp's hosts.json is herdr's - a remote
 * Herdr app machine is reached by its `machine/` ids or engine:"core");
 * then the caller's home engine.
 */
export function pickEngine(
  explicit: Engine | undefined,
  ids: Array<string | undefined>,
  env?: NodeJS.ProcessEnv,
  host?: string,
): Engine {
  if (explicit) return explicit;
  for (const id of ids) {
    if (id === undefined || id === "") continue;
    const engine = engineOfId(id, "layout");
    if (engine) return engine;
  }
  if (host !== undefined && host !== "" && host !== "local") return "herdr";
  return homeEngine(env);
}

/** `t7` with host `ska` -> `ska/t7`. An already-qualified id, or no/local host, is left alone. */
export function qualifyCore(id: string, host: string | undefined): string {
  if (host === undefined || host === "" || host === "local" || id.includes("/")) return id;
  return `${host}/${id}`;
}
