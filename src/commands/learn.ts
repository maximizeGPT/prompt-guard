/**
 * `prompt-guard learn "<prompt>"` — run the corpus-clarify check on a prompt
 * and print up to 3 clarifying questions grounded in past corpus prompts.
 *
 * MVP-3 (v0) is non-interactive: just prints questions. A future iteration
 * will ask the user to answer them and emit an enriched prompt.
 */

import chalk from 'chalk';
import { PromptGuard } from '../index';

export interface LearnOptions {
  prompt: string;
  dbPath?: string;
}

export async function runLearn(opts: LearnOptions): Promise<void> {
  if (!opts.prompt || opts.prompt.trim().length === 0) {
    console.error('Usage: prompt-guard learn "<your prompt>"');
    process.exit(1);
  }

  const guard = new PromptGuard({
    // Only run the corpus-clarify check for this command; we don't want
    // the rule-based checks adding noise to the question output.
    enabledChecks: ['corpus-clarify'],
  });

  const results = await guard.check(opts.prompt);

  // Find the corpus-clarify result
  const clarifyResult = results.find(r => r.questions !== undefined || r.message.includes('clarifying') || r.message.includes('clear') || r.message.includes('No relevant'));

  if (!clarifyResult) {
    console.log(chalk.gray('No corpus-clarify result. Is ~/.prompt-guard/corpus.db populated? Run `prompt-guard ingest` first.'));
    return;
  }

  console.log('');
  console.log(chalk.bold(`PROMPT: "${opts.prompt}"`));
  console.log('');

  if (!clarifyResult.questions || clarifyResult.questions.length === 0) {
    console.log(chalk.green(clarifyResult.message));
    if (clarifyResult.suggestion) console.log(chalk.gray(`  ${clarifyResult.suggestion}`));
    return;
  }

  console.log(chalk.bold.cyan(clarifyResult.message));
  console.log('');

  clarifyResult.questions.forEach((q, i) => {
    console.log(chalk.bold(`Q${i + 1}`) + chalk.gray(` [${q.kind}, conf=${q.confidence.toFixed(2)}]`));
    console.log(`  ${chalk.green(q.text)}`);
    if (q.groundedIn.length > 0) {
      console.log(chalk.gray('  Grounded in:'));
      q.groundedIn.forEach(g => {
        if (g.snippet) {
          console.log(chalk.gray(`    • id=${g.promptId}: "${g.snippet.slice(0, 120)}…"`));
        }
      });
    }
    console.log('');
  });

  if (clarifyResult.diagnostics) {
    const d = clarifyResult.diagnostics as { latencyMs?: number; retrievedCount?: number };
    console.log(chalk.gray(`(retrieved ${d.retrievedCount} past prompts · ${d.latencyMs}ms)`));
  }
}
