# Project Context

## Overview

`prompt-guard-cli` is a context-aware prompt enhancement tool for AI coding agents, with two operating modes:

1. **Static context injection** — reads `.md` files in the project root (PROJECT.md, CONTEXT.md, etc.) and injects them into prompts before they go to the AI. The original mode.
2. **Corpus-grounded clarification** (v0.2) — ingests past developer-AI conversations into a local SQLite corpus and uses Claude Sonnet 4.6 to propose specific clarifying questions grounded in past prompts before sending vague new prompts.

## Problem Solved

Developers waste cycles iterating with AI agents on prompts that lack context the AI can't infer. v0.1 addresses this by injecting project documentation. v0.2 addresses it more deeply by surfacing the specific past clarifications that resolved similar ambiguities before — first-shot correctness.

## Tech Stack

- **Language:** TypeScript 5+ (strict mode)
- **Runtime:** Node 18+
- **Storage:** SQLite via `better-sqlite3` (synchronous, embedded)
- **Retrieval:** SQLite FTS5 (BM25) — no embeddings dependency in v0.2
- **LLM:** Claude Sonnet 4.6 via `@anthropic-ai/sdk@0.95+` with prompt caching
- **Build:** `tsc`
- **Testing:** Jest 29+

## Dependencies

- **@anthropic-ai/sdk** — Sonnet 4.6 calls for question generation and LLM-extractor
- **better-sqlite3** — corpus DB (~/.prompt-guard/corpus.db)
- **chalk** — terminal output
- **commander** — declared but unused (CLI dispatch is hand-rolled)
- **glob** — file pattern matching for ingestion

## Architecture

### Entry Points

- **CLI:** `bin/prompt-guard` — hand-rolled dispatcher (not commander)
- **Library:** `dist/index.js` — exports `PromptGuard`, check registry, types

### Top-level modules (`src/`)

- **`index.ts`** — `PromptGuard` class. Orchestrates check pipeline via the registry.
- **`config-types.ts`** — `Config` interface (extracted to avoid circular deps)
- **`smart-relevance.ts`** — legacy keyword-overlap scorer for static-context path (unwired in v0.2 main flow)

### Checks (`src/checks/`) — registry pattern

- **`types.ts`** — `Check`, `CheckContext`, `CheckResult`, `ClarifyingQuestion`, `ClarificationKind`
- **`registry.ts`** — `ALL_CHECKS[]` + `buildPipeline(enabled[])` filter
- **`files.ts`, `tests.ts`, `criteria.ts`, `constraints.ts`, `local-env.ts`, `context-window.ts`** — six rule-based checks consuming `corpus/heuristics.ts`
- **`corpus-clarify.ts`** — v0.2 corpus-grounded check (uses CorpusReader + QuestionGenerator)

### Corpus (`src/corpus/`)

- **`schema.ts`** — full SQLite DDL incl. FTS5 + clarifying_pairs + eval_runs/eval_cases
- **`db.ts`** — opener, WAL pragmas, idempotent column ALTERs for migrations
- **`env.ts`** — minimal dotenv loader (reads ANTHROPIC_API_KEY from ~/.env)
- **`heuristics.ts`** — shared regex taggers (`tagPrompt`, `detectLocalEnvIssues`)
- **`parsers/`**
  - **`claude-code.ts`** — `~/.claude/projects/*/[uuid].jsonl`
  - **`cowork.ts`** — `~/Library/Application Support/Claude/local-agent-mode-sessions/*/*/local_*/audit.jsonl` + manifest sibling
  - **`shared.ts`** — `extractUserText`, `flattenAssistantContent`, JSONL iterator
- **`writer.ts`** — session writes, project ID derivation (manifest title for Cowork, cwd basename for Claude Code)
- **`snapshots.ts`** — content-addressed code snapshot ingestion (Cowork outputs/ + ~/.Trash)
- **`labeler.ts`** — outcome labeler (Jaccard hash matching) + rule clarifying-pair extractor
- **`llm-extractor.ts`** — Sonnet 4.6 review of rule pairs (v1.1 system prompt with 7-kind taxonomy)
- **`reader.ts`** — `CorpusReader` (BM25 retrieval, project-scoped + global fallback, synthetic-prompt filter)
- **`question-gen.ts`** — `ClaudeQuestionGenerator` (v4 system prompt, structured output via tool_use)
- **`scoring.ts`** — `scoreCase`, `aggregate`, jaccard + KIND_MATCH_FLOOR (0.5)

### Eval (`src/eval/`)

- **`patterns.json`** — vague-verb regex, live-vs-local detectors (config-driven; extend without rebuild)
- **`detect.ts`** — `detectVagueVerb`, `detectVerbDisambiguationQuestion`, `detectLiveVsLocalQ2`
- **`shape-coverage-prompts.json`** — 20 curated prompts (5 each: should-skip, cross-project, adversarial-vague, demosaas-variant)

### Commands (`src/commands/`)

- `ingest.ts`, `stats.ts`, `dedupe-prompts.ts`, `label-llm.ts`, `label-gold.ts`, `backfill-reasons.ts`, `learn.ts`, `eval.ts`

### Tests (`tests/`)

15 Jest tests across `index.test.ts` + `registry.test.ts`. Tests cover check behavior, token estimation, sanitization, registry construction, `enabledChecks` filtering, corpus-clarify stub gating.

## Coding Conventions

See [CONTEXT.md](./CONTEXT.md). TypeScript strict mode, async/await over raw Promises, chalk for terminal output, JSDoc on public APIs, descriptive variable names over comments.

## Performance Constraints

- **Ingest:** ~2 sec for 181 sources on Mac M4 16GB. Idempotent.
- **Eval (gold):** 38 cases × ~5 sec/call sequential ≈ 3 min. Cost ~$0.30.
- **Learn (single prompt):** ~5 sec, ~$0.005-0.01/call.
- **Build:** `tsc` ~1 sec.

## Privacy

Corpus stays local in `~/.prompt-guard/corpus.db`. Anthropic API calls only when `learn` or `eval` runs. Past prompts retrieved by BM25 are sent as context to the API.
