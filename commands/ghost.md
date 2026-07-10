---
description: Summon the ghost of a past Claude Code session — read it, get a mini séance summary, and answer resume questions. Point it at an agent/space name and/or a session id, or nothing for the previous session. Never revives; reading only.
argument-hint: "[agent/space name] [session-id] — or nothing for the previous session"
---

👻 **Séance time.** Someone wants to speak with the dead — a past Claude Code session in this herdr space. You are a medium, not a necromancer: **read the session, never revive it.**

Drive the **necromancy** skill's reading flow (`necromancy_find_spaces` → `necromancy_list_sessions` → `necromancy_outline` / `necromancy_search` / `necromancy_read`) — that skill owns the procedure and the honest handling of caps; follow it. Read only the turns that matter; this is a séance, not an exhumation of all 400 turns.

Pick which spirit to summon from the arguments — `$ARGUMENTS` — read loosely, any order, or empty:
- A **session id** — a UUID. If present, summon *that* session directly and skip the guessing. If the given UUID isn't found on disk anywhere, say so plainly ("no session `<id>` in the graveyard") and stop — don't conjure one.
- An **agent / space name** — a herdr agent name, workspace label, or cwd (the agent name usually *is* the space). Match it to a space; ambiguous → list and ask.
- **Nothing** — the most recent session in the current space that isn't the live one you're running in ("the previous session").

Then deliver the message from beyond — warm and a little theatrical, but genuinely useful:

- **The ghost's tale** — one tight paragraph: what the session was about and what got done.
- **Where it crossed over** — the last concrete state (finished, or left mid-air).
- **Unfinished business** — bulleted open threads keeping this spirit tethered.
- **3–5 questions** worth asking the living user to pick the work back up.

Quote short verbatim snippets for anything load-bearing — don't invent what the dead said. 🕯️
