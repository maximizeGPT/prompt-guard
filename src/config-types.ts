/**
 * Config interface, extracted from index.ts so checks/* can import it
 * without circular deps.
 */

export interface Config {
  contextFiles: string[];
  enabledChecks: string[];
  autoInject: boolean;
  confirmBeforeSend: boolean;
  maxContextTokens: number;
  modelLimits: Record<string, number>;
  /**
   * Corpus DB path override. Default: ~/.prompt-guard/corpus.db.
   * Set to `false` to disable corpus loading entirely (useful for tests).
   * Set to a path string to use a different DB.
   */
  corpusDbPath?: string | false;
}
