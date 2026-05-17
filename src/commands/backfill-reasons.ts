/**
 * Backfill `reason` column on existing LLM-extracted clarifying_pairs.
 * Preserves the original verdicts (kind, text, confidence); only fills in
 * the reason field that earlier runs forgot to persist.
 */

import chalk from 'chalk';
import { openDb, DEFAULT_DB_PATH } from '../corpus/db';
import { ClaudeClarificationExtractor, estimateCost } from '../corpus/llm-extractor';

export interface BackfillReasonsOptions {
  dbPath?: string;
}

interface Row {
  pair_id: number;
  orig_content: string;
  clar_content: string;
  rule_kind: string | null;
  rule_text: string | null;
}

export async function runBackfillReasons(opts: BackfillReasonsOptions = {}): Promise<void> {
  const dbPath = opts.dbPath || DEFAULT_DB_PATH;
  const db = openDb({ dbPath });

  // One row per unique LLM pair (was duplicating via cp_rule join previously).
  // Pick ANY matching rule row via GROUP BY — rule_kind/rule_text is just context for the LLM call.
  const rows = db.prepare(`
    SELECT
      cp.pair_id,
      orig.content AS orig_content,
      clar.content AS clar_content,
      MAX(cp_rule.clarification_kind) AS rule_kind,
      MAX(cp_rule.clarification_text) AS rule_text
    FROM clarifying_pairs cp
    JOIN prompts orig ON orig.prompt_id = cp.originating_prompt_id
    JOIN prompts clar ON clar.prompt_id = cp.clarifying_prompt_id
    LEFT JOIN clarifying_pairs cp_rule
      ON cp_rule.originating_prompt_id = cp.originating_prompt_id
      AND cp_rule.clarifying_prompt_id = cp.clarifying_prompt_id
      AND cp_rule.extraction_method = 'rule'
    WHERE cp.extraction_method = 'llm'
      AND (cp.reason IS NULL OR cp.reason = '')
    GROUP BY cp.pair_id
    ORDER BY cp.pair_id
  `).all() as Row[];

  console.log(chalk.bold('\nBackfilling LLM reasons'));
  console.log(chalk.gray(`  DB:               ${dbPath}`));
  console.log(chalk.gray(`  Rows to backfill: ${rows.length}`));
  console.log(chalk.gray(`  Concurrency:      1 (sequential, safe for tier-1 rate limit)`));

  if (rows.length === 0) {
    console.log(chalk.green('All LLM rows already have reasons.'));
    db.close();
    return;
  }

  const extractor = new ClaudeClarificationExtractor();
  const updateReason = db.prepare(`UPDATE clarifying_pairs SET reason = ? WHERE pair_id = ?`);

  let completed = 0;
  let filled = 0;
  let errors = 0;
  let totalCost = 0;
  const startedAt = Date.now();

  for (const row of rows) {
    const verdict = await extractor.extract({
      origContent: row.orig_content,
      clarContent: row.clar_content,
      ruleKind: row.rule_kind || 'unknown',
      ruleText: row.rule_text || '',
    });
    totalCost += estimateCost(verdict);
    completed += 1;

    const isErr = verdict.errorClass || verdict.reason.startsWith('LLM API error') || verdict.reason.startsWith('LLM did not');
    if (isErr) {
      errors += 1;
      console.log(`[${String(completed).padStart(3)}/${rows.length}] ${chalk.red('✗ ERROR')} pair_id=${row.pair_id} ${verdict.errorClass || ''}${verdict.errorStatus !== undefined ? `(${verdict.errorStatus})` : ''}`);
    } else if (verdict.reason) {
      updateReason.run(verdict.reason, row.pair_id);
      filled += 1;
      const shortReason = verdict.reason.replace(/\s+/g, ' ').slice(0, 90);
      console.log(`[${String(completed).padStart(3)}/${rows.length}] ${chalk.green('✓ FILLED')} pair_id=${row.pair_id}  ${chalk.gray('"' + shortReason + (verdict.reason.length > 90 ? '…' : '') + '"')}`);
    }
  }

  const wallSec = (Date.now() - startedAt) / 1000;
  console.log('');
  console.log(chalk.bold('=== Backfill summary ==='));
  console.log(`  Processed: ${completed}`);
  console.log(`  Filled:    ${chalk.green(filled)}`);
  console.log(`  Errors:    ${errors > 0 ? chalk.red(errors) : '0'}`);
  console.log(`  Cost:      $${totalCost.toFixed(4)}`);
  console.log(`  Wall time: ${wallSec.toFixed(1)}s`);
  console.log('');
  if (errors > 0) console.log(chalk.gray(`Re-run \`prompt-guard backfill-reasons\` to retry the ${errors} errors.`));

  db.close();
}
