# Ghost-command prompt faithfulness pilot — research

**What this is:** Requirements + method for an A/B pilot that picks the prompt-strategy variant for `/herderp:ghost` (`commands/ghost.md`) yielding the most truthful, grounded, non-hallucinated session summaries.

**Date:** 2026-07-10 · **Status:** SUPERSEDED by a lighter build (see note) — kept as design history

> **Pivot (2026-07-10):** the heavyweight 4-variant × 30-session × 3-run statistical A/B (~720 agent runs) was descoped for cost — the user has other projects running and did not want the usage. What actually shipped is the *deterministic core* of what the pilot was chasing: a regex-based **"always grab" anchor extractor** (`src/necromancy/anchors.ts` → `necromancy_anchors` tool) that pulls the load-bearing facts (ask, final state, commits, PRs, versions, files, errors, tests, decisions) with **no model call**, plus a **planted-needle test** proving nothing important is missed, wired into `/herderp:ghost` and the necromancy skill. This grounds every summary on extracted evidence — the same anti-hallucination goal, achieved cheaply and deterministically instead of by benchmark. The statistical A/B below remains a valid future option if a prompt-strategy question ever needs settling at scale.

**Still open:** **MUST-VERIFY-FIRST** — that an in-session Agent subagent inherits the `necromancy_*` MCP tools (the pilot collapses otherwise; see Harness mechanics). Also: judge-validation acceptance threshold; near-tie numeric boundary; coverage-floor value; results schema/path; 30-session sampling recipe. Operational items deferred to plan.

---

## Problem

`/herderp:ghost` reads a past Claude Code session off disk and summarizes it for the user. The risk is **hallucination** — the model narrating what it *assumes* happened instead of what the transcript actually says. The current prompt guards this softly ("quote snippets, don't invent"). We don't know if that's the best we can do. This pilot measures competing prompt strategies against a fabrication metric and bakes the winner into the command.

This is a measurement task, not a feature. The deliverable of the *build* phase is: (1) a reusable in-session eval harness, (2) pilot results, (3) an updated `commands/ghost.md` carrying the winning strategy.

## Actors

- **User** — wants a session catch-up they can trust without re-reading the transcript. Just asked (2026-07-10) for the output to be *normal/plain*, not themed — so grounding must not come at the cost of readability.
- **The ghost command** — the artifact under test.
- **The judge** — a fresh subagent that scores faithfulness against ground truth.

## The four variants under test

| ID | Strategy | Prompt mechanism |
|---|---|---|
| **A** | Current (baseline) | "Quote short verbatim snippets for anything load-bearing — don't invent." |
| **B** | Citation-forced | Every load-bearing claim must carry a turn-index `[#N]` from outline/read; a claim with no index is disallowed. |
| **C** | Extract-first | Deterministically pull anchors *before* summarizing — first user turn, last turn, all user turns (`outline filter:user`), targeted `read`s — then build only from those. |
| **D** | Draft-then-verify | Draft the summary, then a second pass re-reads and strikes any claim not supported by a real turn. ~2× cost; included as the accuracy gold-standard. |

Note: "use jq to pull headlines" (the user's original framing) is subsumed by C — the `necromancy_*` tools already do deterministic verbatim extraction, so C uses those rather than raw jq on the `.jsonl`.

## Method

### Scoring dimensions — three co-equal axes (+ reliability)
Scoring decomposes each summary into atomic claims; the judge scores **every summary on all three axes below**, each reported per-variant with bootstrap CIs. None is an afterthought — a good summary is grounded **and** accurate **and** complete. A variant that aces one axis by tanking another does not win.

1. **Faithfulness — fabrication rate.** Unsupported claims ÷ total claims (precision). "Is every claim backed by a real turn?" A *rate*, not a raw count, so terseness can't win by saying less. Lower is better.
2. **Accuracy — characterization correctness.** Of the *supported* claims, the fraction characterized correctly (right actor, right outcome, no distortion or misattribution). Distinct from faithfulness: a claim can point at a real turn yet describe it wrong. Higher is better.
3. **Coverage — completeness / recall.** The judge independently lists the load-bearing threads the transcript actually contains (final state, open work, key decisions); coverage = fraction the summary captured. Higher is better.

Also tracked: **reliability** — run-to-run consistency across the 3 runs per cell (a good variant is stable, not occasionally good), reported as within-cell variance on each axis.

### Decision rule
- Every axis is reported as a **three-axis scorecard per variant** (+ reliability) with **paired-difference CIs** vs baseline A (same sessions) — the winner is argued on all three, never a single number.
- **Combination rule: floors on all three, then faithfulness ranks.** A variant must clear a minimum bar on *all three* axes (faithfulness ceiling, accuracy floor, coverage floor) to be *eligible*; among those clearing every floor, the **lowest fabrication rate wins.** Every axis is decision-relevant as a gate, but "most truthful" is the final arbiter — a variant cannot win by being complete-but-fabricated or grounded-but-empty. Floor values set at plan time (defaults proposed there, e.g. accuracy ≥0.9, coverage ≥0.8 of load-bearing threads).
- **A near-tie is "inconclusive, scale up"**, not a winner — a 30-session pilot finds a *clear* winner, not a ~2–3% gap. Numeric boundary set at plan time.

### Harness — in-session, not `run_eval`
**Hard constraint (verified):** `skill-eval`'s `run_eval` spawns isolated sessions with **no MCP servers**. The ghost command depends on `necromancy_*` MCP tools + on-disk session files, so it **cannot be evaluated end-to-end by naive `run_eval`.** The pilot therefore runs an **in-session harness**: each variant is executed against real sessions where the tools are live, outputs captured, then graded.

### Paired design (highest-leverage choice)
Every variant runs against the **same** set of sessions. Pairing cancels session-difficulty variance — *"a paired-differences test lets us eliminate the variance in question difficulty"* (Anthropic, *Adding Error Bars to Evals*). This is what lets N≈30 suffice.

### Harness mechanics (enough to plan against)
- **Variant instantiation:** each variant is the *same* necromancy reading flow with a different summary-generation instruction block — swappable prompt bodies fed to a dispatched in-session subagent, **not** four separate command files.
- **Execution:** in-session — the main session dispatches variant-runner subagents that have the live `necromancy_*` tools. This is deliberately **not** skill-eval's isolated runner (which strips MCP — the whole reason this harness exists).
- **⚠ MUST VERIFY FIRST (plan spike):** confirm an in-session Agent subagent actually inherits the `necromancy_*` MCP tools. Both the variant runners and the judge need them; the pilot collapses if they don't. First thing plan/build proves.
- **Capture + storage:** each run writes a record — session id, variant, run #, raw summary, normalized summary, judge per-claim verdicts, scores — to a results dir under `.code-foundations/` (schema/path fixed at plan time). 30 × 4 × 3 = **360** summary records + scorecards.
- **"Reusable" means re-runnable:** a documented procedure plus a scoring script over the stored records — not a fully autonomous harness.

### Judge — blind, per-claim, transcript-grounded
- Fresh subagent that reads the **actual transcript turns** (via `necromancy_outline`/`search`/`read`) and emits a **three-axis scorecard** per summary — faithfulness (each atomic claim supported/unsupported, FActScore-style: *"atomic facts and computes the percentage... supported"*, automated scorer tracks humans *"with less than a 2% error rate"*), **accuracy** (each supported claim correct/distorted), and **coverage** (which of the transcript's load-bearing threads the summary hit or missed). One pass, all three, per claim where applicable.
- **ToolSearch first:** the `necromancy_*` tools are deferred in this environment — the judge (and every runner) must `ToolSearch("select:mcp__plugin_herderp_derp__necromancy_read,...")` to load schemas before calling. Verified working in the spike.
- **Blinding via normalization.** Variant B mandates `[#N]` citations and C/D have distinctive shapes, so a raw label-strip can't hide authorship. Before judging, a normalization pass strips citation markers and format tells so the judge scores *claims, not style.* Blinding stays imperfect — acknowledged, not assumed away.
- **Must search before ruling "unsupported."** The reading tools are capped (`truncated`/`nextOffset`); on 400+ turn sessions a real supporting turn can sit beyond a page. The judge must `search` for support before marking a claim fabricated — else a variant is penalized for the tool's cap, not for lying.
- **Binary per-claim, not Likert** — scales need larger samples to separate variants (Hamel Husain).
- **Ground truth is asymmetric.** Only the control (`09143995`) has an *independent* reference (already fully read). For the other 29, the transcript is both what the judge derives the reference from and verifies against — so judge reliability is load-bearing, hence:
- **Judge validation gate:** before any variant ranking is trusted, hand-label a ~25-claim subset (control claims included) and confirm the judge agrees (target ≥90%; exact threshold open). An unvalidated judge invalidates the pilot.

### Test set — 30 × 3, cross-graveyard
- **N = 30 distinct sessions**, sampled across the whole `~/.claude/projects` graveyard (this herderp space has only ~4–5 content-rich sessions; the rest are 0-message stubs). Sample for **shape diversity**: short, medium, long (400+ turns), and edge cases (near-empty, tool-heavy).
- **R = 3 runs** per (session × variant) cell to average per-generation non-determinism. LLM outputs vary run-to-run regardless of any temperature knob (which an in-session harness doesn't expose anyway); 3 is a pragmatic floor — if CIs overlap, add sessions before adding re-runs.
- **Control:** session `09143995` (already fully read; known ground truth) is a mandatory member of the 30 — a case where we can independently verify the judge.
- ~30 × 4 variants × 3 = **360 summaries**, all read by the judge.

## Boundaries / out of scope
- Not changing the `necromancy_*` tools or the command's *reading flow* — only its **summary-generation prompt**.
- Not a publishable benchmark. Pilot-grade: pick a clear winner, iterate.
- Not testing the theme/tone (already decided: plain output). Faithfulness only.
- The separate `find_spaces`/`list_sessions` output-overflow bug is **not** in scope here.

## Risks / what must be true
| Risk | Mitigation |
|---|---|
| **In-session subagent lacks `necromancy_*` MCP** (whole pilot collapses) | Verify-first spike before any runs — both variant runners and judge need live tools. The one gating unknown. |
| **Judge is itself unreliable** (rewards confident prose) | Judge-validation gate against hand-labels before any variant ranking is trusted. This is the load-bearing assumption. |
| **Terse variant games the metric** (fewer claims → lower fabrication) | Fabrication is a *rate*, and a coverage floor gates eligibility — a near-empty summary fails coverage before it can win on precision. |
| **Judge's capped reads miss a supporting turn** → false fabrications on long sessions | Judge must `search` for support before ruling a claim unsupported; caps are honored, not ignored. |
| **Blinding leaks via variant B's `[#N]` format** | Normalization pass strips citations/format tells pre-judging; residual leak acknowledged, not assumed away. |
| **N=30 too small for a close race** | Pre-committed rule: near-tie ⇒ inconclusive, scale N. Big grounding effects (B/C/D vs A) should be visible at 30. |
| **Variant D's 2× cost not worth it** | Explicitly compared; if B or C already floors fabrication near 0, D's marginal value is reportable, not assumed. |
| **Cross-space sampling pulls unreadable/corrupt sessions** | Sampling recipe filters to sessions with real content; edge cases included deliberately, not accidentally. |
| **Non-determinism swamps the signal at R=3** | If CIs overlap heavily, spend budget on more distinct sessions before more re-runs (distinct cases cut standard error faster than resampling). |

## Evidence base (from web research, 2026-07-10)
- **Pilot size:** Anthropic *Demystifying Evals* — *"20-50 simple tasks drawn from real failures is a great start."* Statistical rigor to detect a 3pp gap at 80% power: *"at least 1,000 questions"* (arXiv 2411.00640). 30 is a defensible pilot; it will not resolve a small gap.
- **Pairing:** Anthropic — paired-differences test eliminates question-difficulty variance. Highest-leverage design choice.
- **Runs/variance:** No consensus repeat count (LangSmith `num_repetitions` defaults to 1; rigor papers use 10–20). 3 is a pragmatic floor; more distinct cases beats more re-runs.
- **Judge method:** FActScore atomic-fact decomposition (<2% error vs humans); RAGAS faithfulness = claims-supported / total-claims. Binary per-claim over Likert.
- **Judge bias:** LLM judges hit *">80% agreement"* with humans but carry position/verbosity/self-enhancement bias (Zheng et al. 2023, MT-Bench) → blind + validate.

## What comes next
`/code-foundations:plan .code-foundations/research/2026-07-10-ghost-prompt-faithfulness-pilot.md`
