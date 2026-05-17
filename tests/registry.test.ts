/**
 * Tests for the check registry — specifically the enabledChecks bug fix
 * (this config field was previously silently ignored).
 */

import { PromptGuard } from '../src/index';
import { ALL_CHECKS, buildPipeline } from '../src/checks/registry';

describe('Check registry', () => {
  describe('ALL_CHECKS', () => {
    it('contains the 6 original checks plus corpus-clarify', () => {
      const ids = ALL_CHECKS.map(c => c.id);
      expect(ids).toContain('files-mentioned');
      expect(ids).toContain('tests-mentioned');
      expect(ids).toContain('success-criteria');
      expect(ids).toContain('constraints');
      expect(ids).toContain('local-env');
      expect(ids).toContain('context-window');
      expect(ids).toContain('corpus-clarify');
    });

    it('every check has a non-empty id and description', () => {
      for (const c of ALL_CHECKS) {
        expect(c.id).toBeTruthy();
        expect(c.description).toBeTruthy();
        expect(typeof c.run).toBe('function');
      }
    });
  });

  describe('buildPipeline', () => {
    it('filters by enabled ids', () => {
      const pipeline = buildPipeline(['files-mentioned', 'local-env']);
      expect(pipeline.length).toBe(2);
      expect(pipeline.map(c => c.id)).toEqual(['files-mentioned', 'local-env']);
    });

    it('silently ignores unknown ids', () => {
      const pipeline = buildPipeline(['files-mentioned', 'bogus-check-id']);
      expect(pipeline.length).toBe(1);
      expect(pipeline[0].id).toBe('files-mentioned');
    });

    it('returns empty for empty input', () => {
      const pipeline = buildPipeline([]);
      expect(pipeline.length).toBe(0);
    });
  });

  describe('enabledChecks config field is now honored', () => {
    it('disabling all checks produces no results', async () => {
      const guard = new PromptGuard({
        enabledChecks: [],
        contextFiles: [],
        maxContextTokens: 1000,
      });
      const results = await guard.check('refactor auth');
      expect(results.length).toBe(0);
    });

    it('enabling only files-mentioned produces only that warning', async () => {
      const guard = new PromptGuard({
        enabledChecks: ['files-mentioned'],
        contextFiles: [],
        maxContextTokens: 1000,
      });
      const results = await guard.check('refactor auth');
      expect(results.length).toBe(1);
      expect(results[0].message).toContain('files');
    });

    it('corpus-clarify is skipped when no corpus is wired', async () => {
      // Explicitly disable corpus loading so the check's requires: 'corpus' gate skips it.
      const guard = new PromptGuard({
        enabledChecks: ['corpus-clarify'],
        contextFiles: [],
        maxContextTokens: 1000,
        corpusDbPath: false,
      });
      const results = await guard.check('refactor auth');
      expect(results.length).toBe(0);
    });
  });
});
