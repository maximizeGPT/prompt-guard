import type { Check } from './types';
import { tagPrompt } from '../corpus/heuristics';

export const filesCheck: Check = {
  id: 'files-mentioned',
  description: 'Warn when prompt has no file/path references',
  requires: 'none',
  async run(ctx) {
    if (tagPrompt(ctx.prompt).has_files) return [];
    return [{
      type: 'warning',
      message: 'No specific files mentioned',
      suggestion: 'Add file paths like "src/auth/**" or "update login.js"',
    }];
  },
};
