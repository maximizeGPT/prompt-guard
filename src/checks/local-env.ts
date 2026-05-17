import type { Check } from './types';
import { detectLocalEnvIssues } from '../corpus/heuristics';

export const localEnvCheck: Check = {
  id: 'local-env',
  description: 'Warn when prompt contains local environment references (overfitting risk)',
  requires: 'none',
  async run(ctx) {
    const issues = detectLocalEnvIssues(ctx.prompt);
    if (issues.length === 0) return [];
    return [{
      type: 'warning',
      message: 'Prompt contains local environment references',
      suggestion: `Remove: ${issues.join(', ')}. Use relative paths and generic config instead.`,
    }];
  },
};
