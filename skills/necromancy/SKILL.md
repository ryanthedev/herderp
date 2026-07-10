---
name: necromancy
description: Finds, previews, and revives a previous Claude Code agent session recorded on disk for a project or workspace ("space"), resuming the chosen one in a herdr pane via `claude --resume`. Use when the user wants to bring back, resurrect, resume, restore, or find a lost or previous Claude Code session or agent, asks what past sessions exist for a project/workspace/cwd, or wants to reattach to a conversation that isn't running anymore. Not for starting a brand-new Claude Code session from scratch, general herdr workspace/pane/tab management with no revival intent (use the herderp MCP tools directly), or reviving non-Claude agent CLIs (unsupported in v1 — Claude sessions only).
---

# necromancy

Bring back a Claude Code session the user has lost track of. All state and side effects live behind three MCP tools (`necromancy_find_spaces`, `necromancy_list_sessions`, `necromancy_revive`) — this skill is the conversation that drives them in the right order and reads their results honestly.

## Flow

1. **Resolve a target to a space.** The user may point at a space by workspace id, a label, a project cwd, something that names a session directly, or nothing at all.
   - Call `necromancy_find_spaces` first, always — it costs nothing and gives you everything needed to match or to show candidates.
   - **No target given:** present the returned spaces (cwd, label, session count, last activity) and ask which one.
   - **A target given:** match it case-insensitively against each space's `cwd`, `label`, and `workspaceId`.
     - **Zero matches:** say so plainly ("nothing matched '<target>'") and fall back to presenting the full space list, same as the no-target case — never guess a cwd that wasn't returned.
     - **One match:** proceed with that space's cwd.
     - **More than one match:** list the matches and ask the user to pick — never silently choose the first one.
   - If the target looks like it's naming a *session* directly (a UUID, or a description that only makes sense as a session, not a project) rather than a space, skip straight to step 2 with whatever cwd you can resolve, and treat the target as a session filter once you have the list.

2. **List and preview sessions for the chosen space.** Call `necromancy_list_sessions({ space: <cwd> })`.
   - No sessions returned → tell the user plainly that no revivable sessions were found for that space and stop; don't retry or invent one.
   - Otherwise, present the sessions newest-first with their preview, message count, and whether each is already live in herdr — this is exactly what the tool gives you, so surface it rather than re-deriving it.

3. **Pick one.** Ask the user to choose from the presented list (or confirm a session you narrowed to in step 1). If the chosen session is already marked `live: true`, say so and confirm before continuing — reviving it again would launch a second, duplicate `claude --resume` in a new pane rather than reattaching to the one already running.

4. **Revive.** Call `necromancy_revive({ sessionId, cwd })`. Report the result honestly:
   - `detected: true` → the session is back; give the user the workspace/pane so they know where to look.
   - `detected: false` → herdr hasn't tagged the resumed agent yet (this happens — detection only fires after the agent's first turn, and a slow resume can outlast the bounded wait). Say plainly that the pane was launched but herdr hasn't confirmed detection yet, and suggest checking back rather than reporting false success.

## Degraded environments

Both failure modes below are expected, recoverable states, not bugs — never let either surface as a raw tool error or stack trace.

- **herdr isn't running:** any tool call will fail with a clear, typed error. Tell the user herdr needs to be running for necromancy to do anything, and stop — don't retry in a loop.
- **No session history on this machine:** `necromancy_find_spaces` and `necromancy_list_sessions` return empty lists (not errors) when `~/.claude/projects` doesn't exist. Tell the user no Claude Code session history was found here, rather than implying something went wrong.

## Scope (v1)

Claude Code sessions only — no other agent CLI kind is supported yet. Revival restores the conversation, not the original pane layout/geometry; a fresh workspace/pane is created for it.
