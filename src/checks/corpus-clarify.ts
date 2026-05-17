/**
 * Corpus-grounded clarifying-question check.
 *
 * Uses BM25 retrieval over the local corpus + Claude Sonnet 4.6 question
 * generation to propose up to 3 specific clarifying questions for a given
 * prompt. Questions are grounded in concrete past prompts.
 *
 * v3 system prompt (see src/corpus/question-gen.ts) is the current default.
 */

import type { Check, CheckResult, ClarificationKind } from './types';
import { ClaudeQuestionGenerator, QuestionGenerator } from '../corpus/question-gen';
import type { RetrievedPrompt } from '../corpus/reader';

interface GoldExample {
  pastPrompt: string;
  pastClarification: string;
  kind: ClarificationKind;
}

function fetchGoldClarifications(
  corpus: import('../corpus/reader').CorpusReader,
  retrieved: RetrievedPrompt[]
): GoldExample[] {
  if (retrieved.length === 0) return [];
  const ids = retrieved.map(r => r.promptId).join(',');
  const rows = corpus.db.prepare(`
    SELECT cp.clarification_kind AS kind,
           cp.clarification_text AS text,
           orig.content          AS past_prompt
    FROM clarifying_pairs cp
    JOIN prompts orig ON orig.prompt_id = cp.originating_prompt_id
    WHERE cp.extraction_method = 'manual'
      AND cp.clarification_kind IS NOT NULL
      AND cp.originating_prompt_id IN (${ids})
    LIMIT 6
  `).all() as { kind: string; text: string; past_prompt: string }[];
  return rows.map(r => ({
    pastPrompt: r.past_prompt,
    pastClarification: r.text,
    kind: r.kind as ClarificationKind,
  }));
}

/** Allow tests / future commands to inject a different generator. */
let _generator: QuestionGenerator | null = null;
export function setQuestionGenerator(g: QuestionGenerator | null): void { _generator = g; }
function getGenerator(): QuestionGenerator { return _generator ?? new ClaudeQuestionGenerator(); }

export const corpusClarifyCheck: Check = {
  id: 'corpus-clarify',
  description: 'Propose clarifying questions grounded in past corpus prompts',
  requires: 'corpus',
  async run(ctx): Promise<CheckResult[]> {
    const corpus = ctx.corpus;
    if (!corpus) return [];

    const retrieved = corpus.retrieve({
      query: ctx.prompt,
      projectId: ctx.projectId,
      limit: 8,
      globalFallback: true,
    });

    if (retrieved.length === 0) {
      return [{
        type: 'info',
        message: 'No relevant past prompts found in your corpus',
        diagnostics: { retrievedCount: 0 },
      }];
    }

    const exampleClarifications = fetchGoldClarifications(corpus, retrieved);
    const gen = getGenerator();
    const result = await gen.generate({
      prompt: ctx.prompt,
      retrieved,
      exampleClarifications,
    });

    if (result.errorClass) {
      return [{
        type: 'warning',
        message: `Corpus-clarify failed: ${result.errorClass}${result.errorStatus !== undefined ? `(${result.errorStatus})` : ''}`,
        suggestion: result.errorMessage?.slice(0, 200),
        diagnostics: { errorClass: result.errorClass, errorStatus: result.errorStatus },
      }];
    }

    if (result.questions.length === 0) {
      return [{
        type: 'info',
        message: 'Prompt is clear — no clarification proposed',
        suggestion: result.skipReason,
        diagnostics: { retrievedCount: retrieved.length, skipReason: result.skipReason },
      }];
    }

    return [{
      type: 'info',
      message: `${result.questions.length} clarifying question${result.questions.length > 1 ? 's' : ''} grounded in your corpus`,
      questions: result.questions,
      diagnostics: {
        retrievedCount: retrieved.length,
        latencyMs: result.latencyMs,
        modelName: result.modelName,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cachedInputTokens: result.cachedInputTokens,
      },
    }];
  },
};
