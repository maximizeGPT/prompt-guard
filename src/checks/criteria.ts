import type { Check } from './types';
import { tagPrompt } from '../corpus/heuristics';

export const criteriaCheck: Check = {
  id: 'success-criteria',
  description: 'Warn when prompt has no clear success criteria',
  requires: 'none',
  async run(ctx) {
    if (tagPrompt(ctx.prompt).has_criteria) return [];
    return [{
      type: 'warning',
      message: 'No clear success criteria',
      suggestion: 'Add "should pass all tests" or "must handle 10k req/s"',
    }];
  },
};
