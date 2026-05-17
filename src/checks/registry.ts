/**
 * Check registry. The orchestrator (PromptGuard.check) iterates checks in
 * registration order and calls each whose id appears in `config.enabledChecks`.
 *
 * Adding a new check: append it to ALL_CHECKS and (if it should run by default)
 * add its id to the default `enabledChecks` array in PromptGuard's config.
 */

import type { Check } from './types';
import { filesCheck } from './files';
import { testsCheck } from './tests';
import { criteriaCheck } from './criteria';
import { constraintsCheck } from './constraints';
import { localEnvCheck } from './local-env';
import { contextWindowCheck } from './context-window';
import { corpusClarifyCheck } from './corpus-clarify';

export const ALL_CHECKS: Check[] = [
  filesCheck,
  testsCheck,
  criteriaCheck,
  constraintsCheck,
  localEnvCheck,
  contextWindowCheck,
  corpusClarifyCheck,
];

/**
 * Filter the registry by the enabled-id list from config.
 * Preserves registration order. Unknown ids are silently ignored.
 */
export function buildPipeline(enabled: string[]): Check[] {
  const set = new Set(enabled);
  return ALL_CHECKS.filter(c => set.has(c.id));
}
