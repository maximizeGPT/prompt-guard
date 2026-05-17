import type { Check } from './types';
import { tagPrompt } from '../corpus/heuristics';

export const testsCheck: Check = {
  id: 'tests-mentioned',
  description: 'Warn when prompt does not mention tests/validation',
  requires: 'none',
  async run(ctx) {
    if (tagPrompt(ctx.prompt).has_tests) return [];
    return [{
      type: 'warning',
      message: 'No tests or validation criteria mentioned',
      suggestion: 'Add "include tests" or "should handle X cases"',
    }];
  },
};
