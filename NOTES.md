# Prompt Guard — long-term notes

Forward-looking deferred items, architectural quirks, and refactor targets. **Not** a results log — see [SHIP.md](./SHIP.md) for what was actually delivered and measured in each version.

Entries here describe work *to do* or *to be aware of when changing X*. When a deferred item ships, move its result writeup to SHIP.md and trim the entry here to a one-line "shipped in vN.N".

---

## Self-referential project exclusion

The `prompt-guard` project's own Claude Code session JSONLs (from building Prompt Guard itself) appear in the corpus and would pollute gold-extraction. Hardcoded exclusion in `src/checks/types.ts` (`EXCLUDED_PROJECT_CLAUSE`) and `src/corpus/reader.ts` filters out any project where `name = 'prompt-guard'` OR `cwd LIKE '%prompt-guard%'`.

**v0.5:** make excluded-projects list configurable via `.prompt-guard.json` `excludedProjects: string[]`. Generic mechanism beats hardcoded match — needed when others build tools using Prompt Guard's eval harness on their own dev corpora.

## Synthetic-prompt filter is reactive — SCHEDULED post-MVP-4

The regex-per-pattern `isSyntheticPrompt` filter bit v0 development three times in distinct subsystems (rule extractor, hand-labeling, BM25 retrieval). Each time required adding parallel regex copies. **Promoted from "tracked" to "scheduled refactor" — the next-priority refactor after MVP-4 ships.**

**Refactor approach when picked up:**
- Use the cleaned hand-labeled gold subset as training data (positive = real human prompts; negative = harness/paste-backs)
- Light-weight classifier first: gradient-boosted on text features (length, alpha-ratio, first-line shape, structural tokens)
- Fallback to small Sonnet structured-output call if classifier precision plateaus
- Single function, consumed by all three subsystems

## Parser duplicates user messages on Claude Code replay events

Claude Code emits each user message twice on session resume — same `uuid`, different timestamp, second copy carries `isReplay: true`. v0 parser ingested both as distinct prompt rows.

**v0 mitigation (shipped):** isReplay filter in both parsers + in-place dedupe command (`prompt-guard dedupe-prompts`).

**v0.5 cleanup target:** the dedupe command is one-shot; future ingests with the isReplay filter shouldn't need it. Remove after one clean re-ingest validates.

## Title-based project linkage failure modes

Cowork manifests' `cwd` is the VM-internal sandbox path, not host. Project linkage uses manifest `title` instead. Three failure modes documented:
- **Over-segmentation** (most common): different titles for the same project → separate project_ids → narrower retrieval scope. Global fallback mitigates.
- **Under-segmentation**: generic titles ("Untitled session") merge unrelated work. Zero incidents in current corpus.
- **Title shifts mid-iteration**: Cowork lets you rename sessions, manifest reflects new name only.

**v0.5:** `prompt-guard project merge <id1> <id2>` + optional embedding-based title clustering. Manual merging until then.

## Per-turn snapshots (deferred to v1.1)

v0 captures one snapshot per Cowork session = final `outputs/` state. Per-turn snapshots via `file-history-snapshot` events would give turn-granular code state for richer per-prompt diff signal. Deferred until needed.

## Trash basename ↔ project linkage

v0 ingests all `~/.Trash` directories with code and matches to projects via content_hash Jaccard overlap (≥ 0.5) inside the outcome labeler. Threshold tuning may be needed when corpus contains sessions that genuinely end in revert.

## External-API operations — default to sequential

**Operational rule discovered empirically during MVP-1.5:** running the LLM extractor at concurrency 5 on a fresh Tier-1 Anthropic key hit a 55% error rate. Bumping to concurrency 1 dropped errors to 0%.

For any new external-API operation against an unverified account/tier, the safe default is `--concurrency 1`. Move to higher concurrency only AFTER verifying empirical headroom.

Codified in `src/corpus/llm-extractor.ts`: `maxRetries: 8` is the SDK retry budget; `--concurrency 1` is the CLI default for `label-llm` and `eval`.

## Re-ingest reliability (FK constraint failure on largest sessions)

Re-running `prompt-guard ingest` on an existing DB occasionally hits `FOREIGN KEY constraint failed` on the 2 biggest sessions. Suspected cause: transaction-internal interaction between the prompts_fts trigger and delete-then-reinsert on large sessions.

Workaround: nuke + fresh ingest. Acceptable since ingest takes ~2s. Low fix priority — ingest is rarely re-run during normal workflow.

## v0.5 prompt-engineering targets (post-MVP-4)

Tracked in [SHIP.md § v0.5 prompt-engineering targets](./SHIP.md). Three items: verb-disam recovery, kind-match floor brittleness, inherent-ceiling case documentation.
