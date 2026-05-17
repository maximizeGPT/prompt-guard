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
}
