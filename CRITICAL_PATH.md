# Prompt Guard — Critical Path

> Status snapshot as of 2026-05-10 (mid-MVP-1.5).
> Where we are, what's left, what's grown vs. the original plan.

---

## Where we are

| Milestone | Status |
|---|---|
| MVP-0: schema + parsers + ingest + corpus stats | ✅ Shipped (commit `51e77ac`) |
| MVP-1: snapshots + outcome labeler + rule clarifying-pairs | ✅ Shipped (commit `51e77ac`) |
| MVP-1.5: LLM extractor + hand-label TUI | 🔄 In progress |
| MVP-2: Check refactor + `enabledChecks` bug fix | ⏳ Not started |
| MVP-3: corpus-clarify check + `learn` command | ⏳ Not started |
| MVP-4: Eval harness | ⏳ Not started |
| MVP-5: Forward capture (`prompt-guard accept`) | ⏳ Not started (deferred) |

**Project-to-date spend:** ~$3.40 (Anthropic API). Cap: $15.

---

## MVP-1.5 — remaining

| Task | Wall time | Cost | Owner | Status |
|---|---|---|---|---|
| Finish backfill of 48 missing reasons | ~10 min | ~$0.50 | Me | Pending |
| TUI dedupe by `(orig, clar)` | ~15 min | $0 | Me | Pending |
| TUI content truncation at 1500 chars | ~10 min | $0 | Me | Pending |
| Handle 5 kind-conflict cases in TUI | ~10 min | $0 | Me | Pending |
| Walk through 3 cleaned-up pairs | ~5 min | $0 | Me | Pending |
| Hand-label 66 unique pairs | **90 min** | $0 | Mohammed | Pending |
| Commit MVP-1.5 | ~5 min | $0 | Me | Pending |
| **MVP-1.5 total remaining** | **~2.5 hours** | **~$0.50** | | |

Conversation turns expected: **2–3** (cleanup + walkthrough, then a resume turn after each labeling session).

---

## MVP-2 — Check refactor

Pure refactor. No model calls, no cost.

| Task | Estimate |
|---|---|
| Extract 6 existing checks into `src/checks/*.ts` | ~30 min |
| Add `Check` interface + registry + `buildPipeline()` | ~15 min |
| Fix the `enabledChecks: string[]` ignored-config bug (existing) | included |
| Wire `corpus-clarify` stub (real impl in MVP-3) | included |
| Update existing tests; add 2-3 registry tests | ~20 min |
| Verify no behavior change in `check`/`enhance`/`stats` | ~10 min |
| **MVP-2 total** | **~75 min, $0** |

Turns: **1–2.** Reviewable as a standalone PR if you want git history clean.

---

## MVP-3 — corpus-clarify check + `learn` command

This is the actual product. First user-facing feature using the corpus.

| Task | Estimate |
|---|---|
| `src/corpus/reader.ts` — `CorpusReader` with BM25 query helper | ~45 min |
| Project-scoped retrieval + global fallback | ~20 min |
| `src/corpus/question-gen.ts` — adapter interface + Claude default | ~60 min |
| System prompt with ICL examples from your gold subset | ~30 min |
| `src/checks/corpus-clarify.ts` — implements `Check` interface | ~30 min |
| `src/commands/learn.ts` — interactive prompt-and-answer flow | ~60 min |
| Smoke-test on 5–10 real prompts from corpus | ~20 min + ~$0.50 |
| Iterate on prompt template based on output quality | ~30 min + ~$1 |
| **MVP-3 total** | **~5 hours, ~$1.50** |

Turns: **3–5.** Pause points:
- After CorpusReader/BM25 stand up — sanity-check retrieved pairs for a real prompt
- After first question-gen run — surface 3 prompts × 3 questions for your review
- After iteration — final smoke before MVP-4

**Risk:** Question-gen quality is the load-bearing product question. If first results are bad, iteration on the system prompt + ICL examples could add 1–2 more turns and ~$2 more spend.

---

## MVP-4 — Eval harness

The most important component per your original decision. Makes everything else measurable.

| Task | Estimate |
|---|---|
| `src/corpus/scoring.ts` — overlap_at_1, overlap_at_3, coverage, kind_match | ~45 min |
| `src/commands/eval.ts` — run check pipeline against gold subset | ~60 min |
| Replay logic (load gold pair, run corpus-clarify, score vs gold) | ~45 min |
| Write to `eval_runs` + `eval_cases` tables | ~20 min |
| `prompt-guard eval compare <run-A> <run-B>` — A/B diff | ~30 min |
| Baseline eval run on 66 gold pairs | ~10 min + ~$3 |
| Wide eval run on rule+LLM tier (~140 cases) | ~25 min + ~$7 |
| Analyze first results + identify per-kind weak spots | ~30 min |
| **MVP-4 total** | **~5 hours, ~$10** |

Turns: **3–5.** Pause points:
- After scoring functions land — hand-test on 1 known pair
- After baseline eval — surface metrics + per-kind breakdown for your review
- After wide eval — compare with baseline; identify regressions

**Risk:** Wide eval (~$7) is the biggest single spend. Could split into smaller batches if budget gets tight.

---

## MVP-5 — Forward capture (deferred)

Small. Ship after MVP-4 is working. ~30 min code, $0.

---

## Cost projection across remaining phases

| Phase | Est. cost | Running total |
|---|---|---|
| Spent so far | $3.40 | $3.40 |
| MVP-1.5 remaining backfill | $0.50 | $3.90 |
| MVP-2 | $0 | $3.90 |
| MVP-3 dev + iteration | $1.50 | $5.40 |
| MVP-4 baseline + wide eval | $10 | $15.40 |
| **Through MVP-4** | | **~$15.40** |

**At the cap.** Your $15 prefund covers everything up to and including the baseline + wide eval — with no margin for MVP-3 iteration overruns or MVP-4 retries. Realistically expect to top up another $5–10 before MVP-4 finishes.

---

## What's grown since the original plan

1. **MVP-1.5 ballooned from "LLM extractor + TUI" to a 7-task milestone.** Originally I scoped it as 2 components; reality required:
   - Retry-missing infrastructure (rate limit reality)
   - `failed_extraction_pairs` table
   - `backfill-reasons` command (because original writer dropped the LLM reason)
   - Dedupe logic (rule extractor creates 1.42 rows per `(orig, clar)` on average)
   - Display truncation in TUI
   - **Lesson:** infrastructure-around-the-extractor is its own subsystem. I underweighted it.

2. **Hand-label pool dropped from 94 → 66 unique tuples** after dedupe analysis. Still meets the 100-target's *purpose* (per-kind slice stability), just smaller absolute number.

3. **Cost model shifted ~25% over original estimate.** Original MVP-1.5 budget was $2.50; reality is ~$4 (including backfill). MVP-3 and MVP-4 estimates here are conservative — I'm assuming similar overrun pattern.

4. **NOTES.md has 9 deferred items.** Trajectory: each session adds 1-2. Things to revisit before v1:
   - Synthetic-prompt filter → trained classifier (at ~3 design partners)
   - Per-turn snapshots via `file-history-snapshot` (v1.1)
   - Re-ingest FK reliability (low priority)
   - External-API ops default to sequential (rule)
   - Trash basename ↔ project linkage (basename-Jaccard secondary signal)
   - Title-collision detection (suspicious-clusters surfacing)
   - Taxonomy gap: `other` kind possibly missing `external-context` / `domain-grounding`

5. **The `other` clarification kind is doing more work than designed.** 23 of 94 LLM-accepted (~25%) landed in `other`, mostly Acme meeting recap clarifications. Hand-labeling will likely surface a coherent missing kind. v0.5 schema addition pre-MVP-4 is plausible.

---

## What hasn't grown (still good)

- Schema is solid. Only additive changes since MVP-0 (reason column, failed_extraction_pairs table).
- Eval harness scope unchanged.
- MVP-3 corpus-clarify scope unchanged.
- Adapter pattern proves out: ClarificationExtractor → QuestionGenerator will reuse the same shape.
- FTS5 retrieval choice still right; no need for vectors yet.

---

## Risks to watch

1. **Question-gen quality on stock Sonnet 4.6.** No fine-tune, no embeddings. If MVP-3 first results are weak, the only lever is prompt iteration — could eat 1-2 extra turns.
2. **Wide eval cost.** ~$7 single spend. If retrieval quality is poor, that money is wasted on a flawed baseline. Mitigation: keep baseline eval on 66 pairs first, only go wide after metrics look reasonable.
3. **Hand-label session attrition.** 90 min is long. If you do 30/30/30 split, that's 3 evenings. Means MVP-4 baseline may be 3 days out, not tomorrow.
4. **Anthropic credit cap.** $15 is tight. Build a `budget` flag into `eval`/`learn` so commands cap themselves at a fraction of remaining credit. (Not building now; flagging for MVP-4.)
