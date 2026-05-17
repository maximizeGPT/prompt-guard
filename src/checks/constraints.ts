import type { Check } from './types';
import { tagPrompt } from '../corpus/heuristics';

export const constraintsCheck: Check = {
  id: 'constraints',
  description: 'Info: surface when prompt has no explicit constraints',
  requires: 'none',
  async run(ctx) {
    if (tagPrompt(ctx.prompt).has_constraints) return [];
    return [{
      type: 'info',
      message: 'No constraints mentioned',
      suggestion: 'Consider adding "don\'t break existing API" or "keep under 100 lines"',
    }];
  },
};
