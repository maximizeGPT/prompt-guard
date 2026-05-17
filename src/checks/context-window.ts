import type { Check, CheckResult } from './types';

export const contextWindowCheck: Check = {
  id: 'context-window',
  description: 'Error/warn when prompt + context will overflow the configured token budget',
  requires: 'none',
  async run(ctx) {
    const total = ctx.promptTokens + ctx.contextTokens;
    const limit = ctx.config.maxContextTokens;

    if (total > limit) {
      return [{
        type: 'error',
        message: `Context window will be exceeded (~${total} tokens)`,
        suggestion: `Reduce context files or truncate content. Current: ${ctx.contextFiles.length} files, ${ctx.contextTokens} tokens of context. Try removing less relevant .md files.`,
      } as CheckResult];
    }
    if (total > limit * 0.8) {
      return [{
        type: 'warning',
        message: `Approaching context limit (~${total} tokens)`,
        suggestion: 'Consider truncating context files or removing less relevant ones. Leave room for AI response.',
      } as CheckResult];
    }
    return [];
  },
};
