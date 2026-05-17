/**
 * One-shot in-place dedupe of replay-duplicate prompt rows.
 *
 * Background: Claude Code emits each user message twice on session resume —
 * the parser previously ingested both as separate prompt rows. The v1 parser
 * now filters `isReplay`, but the existing DB still has the duplicates.
 *
 * Strategy:
 *   For each (session_id, normalized_content, role) group with >1 prompt row:
 *     canonical = MIN(prompt_id) in the group
 *     For all non-canonical prompts in the group:
 *       - UPDATE clarifying_pairs.originating_prompt_id = canonical
 *       - UPDATE clarifying_pairs.clarifying_prompt_id = canonical
 *       - UPDATE tool_calls.prompt_id = canonical
 *       - DELETE prompt row
 *
 * Preserves all manual labels and LLM verdicts — they get rebound to the
 * canonical prompt_id automatically. No API calls. No re-ingest.
 */

import chalk from 'chalk';
import { openDb, DEFAULT_DB_PATH } from '../corpus/db';

export interface DedupePromptsOptions {
  dbPath?: string;
  dryRun?: boolean;
}

export async function runDedupePrompts(opts: DedupePromptsOptions = {}): Promise<void> {
  const dbPath = opts.dbPath || DEFAULT_DB_PATH;
  const db = openDb({ dbPath });

  console.log(chalk.bold('\nDedupe replay-duplicate prompts'));
  console.log(chalk.gray(`  DB:       ${dbPath}`));
  console.log(chalk.gray(`  Mode:     ${opts.dryRun ? 'DRY-RUN' : 'EXECUTE'}`));
  console.log('');

  // Find duplicate groups — RESTRICT to user prompts with non-trivial content.
  // Assistant turns are commonly empty after flattenAssistantContent (pure tool_use
  // turns) and consolidating them would conflate distinct events. The replay artifact
  // we care about is user-message duplication.
  const groups = db.prepare(`
    SELECT session_id, normalized_content, role, MIN(prompt_id) AS canonical_id, COUNT(*) AS n
    FROM prompts
    WHERE role = 'user'
      AND normalized_content IS NOT NULL
      AND length(trim(normalized_content)) >= 10
    GROUP BY session_id, normalized_content, role
    HAVING n > 1
  `).all() as Array<{ session_id: string; normalized_content: string; role: string; canonical_id: number; n: number }>;

  console.log(chalk.bold(`Found ${groups.length} duplicate groups`));
  const totalDups = groups.reduce((s, g) => s + (g.n - 1), 0);
  console.log(chalk.gray(`  Total duplicate rows to consolidate: ${totalDups}`));
  console.log('');

  if (groups.length === 0) {
    console.log(chalk.green('No duplicates to consolidate.'));
    db.close();
    return;
  }

  if (opts.dryRun) {
    // Show top 5 groups for sanity check
    console.log(chalk.bold('Top 5 groups (preview):'));
    for (const g of groups.slice(0, 5)) {
      const preview = (g.normalized_content || '').slice(0, 80);
      console.log(`  ${g.session_id.slice(0, 16)}…  ${g.role}  x${g.n}  canonical=${g.canonical_id}  '${preview}…'`);
    }
    console.log('');
    console.log(chalk.gray('Run without --dry-run to consolidate.'));
    db.close();
    return;
  }

  // Stats
  let consolidatedPairs = 0;
  let consolidatedTools = 0;
  let deletedPrompts = 0;

  const updateCpOrig = db.prepare(`
    UPDATE clarifying_pairs SET originating_prompt_id = ? WHERE originating_prompt_id = ?
  `);
  const updateCpClar = db.prepare(`
    UPDATE clarifying_pairs SET clarifying_prompt_id = ? WHERE clarifying_prompt_id = ?
  `);
  const updateTool = db.prepare(`
    UPDATE tool_calls SET prompt_id = ? WHERE prompt_id = ?
  `);
  const deletePrompt = db.prepare(`DELETE FROM prompts WHERE prompt_id = ?`);
  const findDups = db.prepare(`
    SELECT prompt_id FROM prompts
    WHERE session_id = ? AND normalized_content = ? AND role = ? AND prompt_id != ?
    ORDER BY prompt_id
  `);

  const tx = db.transaction(() => {
    for (const g of groups) {
      const dups = findDups.all(g.session_id, g.normalized_content, g.role, g.canonical_id) as Array<{ prompt_id: number }>;
      for (const d of dups) {
        // Re-point all references to canonical
        const ce = updateCpOrig.run(g.canonical_id, d.prompt_id).changes;
        const cl = updateCpClar.run(g.canonical_id, d.prompt_id).changes;
        const tc = updateTool.run(g.canonical_id, d.prompt_id).changes;
        consolidatedPairs += ce + cl;
        consolidatedTools += tc;
        // Delete the duplicate (FTS trigger handles its own cleanup)
        deletePrompt.run(d.prompt_id);
        deletedPrompts += 1;
      }
    }

    // Some clarifying_pairs may now have originating_prompt_id == clarifying_prompt_id
    // (e.g., a prompt was both "ORIG of pair X" and "CLAR of pair Y" via different routes
    // and after consolidation those collapse). Drop those self-referential pairs.
    const selfRefDeleted = db.prepare(`
      DELETE FROM clarifying_pairs WHERE originating_prompt_id = clarifying_prompt_id
    `).run().changes;
    if (selfRefDeleted > 0) console.log(chalk.gray(`  Removed ${selfRefDeleted} self-referential clarifying_pairs after consolidation`));

    // After consolidation, some clarifying_pairs may now be exact duplicates
    // (same orig, same clar). Keep MIN(pair_id) per group.
    const dedupePairs = db.prepare(`
      DELETE FROM clarifying_pairs
      WHERE pair_id NOT IN (
        SELECT MIN(pair_id) FROM clarifying_pairs
        GROUP BY originating_prompt_id, clarifying_prompt_id, extraction_method, extractor_version
      )
    `).run().changes;
    if (dedupePairs > 0) console.log(chalk.gray(`  Removed ${dedupePairs} exact-duplicate clarifying_pairs rows after consolidation`));
  });

  tx();

  console.log('');
  console.log(chalk.bold('Consolidation summary'));
  console.log(`  Prompts deleted:         ${chalk.red(deletedPrompts)}`);
  console.log(`  clarifying_pairs FK upd: ${consolidatedPairs}`);
  console.log(`  tool_calls FK upd:       ${consolidatedTools}`);

  const remaining = (db.prepare(`SELECT COUNT(*) AS c FROM prompts`).get() as { c: number }).c;
  console.log(`  Prompts remaining:       ${remaining}`);

  db.close();
}
