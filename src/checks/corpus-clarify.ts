/**
 * Corpus-grounded clarifying-question check.
 *
 * MVP-2 STUB: returns no results. Real implementation lands in MVP-3 with:
 *   - BM25 retrieval over the corpus (project-scoped with global fallback)
 *   - Sonnet 4.6 question generation with structured output
 *   - Up to 3 specific disambiguation questions per prompt
 *
 * Slots into the Check registry as `corpus-clarify`. The check is gated by
 * `requires: 'corpus'`; when no corpus DB exists or this check is disabled
 * in `enabledChecks`, it's skipped silently.
 */

import type { Check } from './types';

export const corpusClarifyCheck: Check = {
  id: 'corpus-clarify',
  description: 'Propose clarifying questions grounded in past corpus prompts (stub in MVP-2)',
  requires: 'corpus',
  async run(_ctx) {
    // Stub. Real implementation in MVP-3.
    return [];
  },
};
