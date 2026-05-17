/**
 * Hand-label TUI for the gold subset.
 * Keyboard-driven, resume-capable, persists after every label.
 *
 * Each label writes a row with extraction_method='manual', is_in_gold_subset=1:
 * - Accept: clarification_kind = LLM's kind, clarification_text = LLM's refined text
 * - Reject: clarification_kind = NULL, clarification_text = '__rejected__'
 * - Edit: clarification_kind = LLM's kind, clarification_text = user's edited text
 * - Fix-kind: clarification_kind = new kind, clarification_text = LLM's refined text
 *
 * Skip does NOT persist — the pair reappears on next run.
 * Quit exits cleanly; prior labels are already in DB.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import chalk from 'chalk';
import { openDb, DEFAULT_DB_PATH } from '../corpus/db';

const KINDS = ['file-scope', 'success-criteria', 'constraint', 'data-shape', 'ui-detail', 'other'] as const;
type Kind = typeof KINDS[number];

const LABELER_VERSION = 'tui-v0';
const REJECT_MARKER = '__rejected__';

/**
 * SQL fragment excluding self-referential projects from gold extraction.
 * See NOTES.md → "Self-referential project exclusion".
 *
 * Hardcoded for v0. Future: read from .prompt-guard.json `excludedProjects`.
 */
const EXCLUDED_PROJECT_CLAUSE = `
  p.name != 'prompt-guard'
  AND (p.cwd IS NULL OR p.cwd NOT LIKE '%prompt-guard%')
`;

export interface LabelGoldOptions {
  preview?: boolean;
  limit?: number;
  dbPath?: string;
}

interface PairRow {
  llm_pair_id: number;
  originating_prompt_id: number;
  clarifying_prompt_id: number;
  session_id: string;
  project_name: string | null;
  llm_kind: string;
  llm_text: string;
  llm_confidence: number;
  llm_reason: string | null;
  rule_kind: string | null;
  rule_text: string | null;
  orig_content: string;
  orig_turn: number;
  clar_content: string;
  clar_turn: number;
  session_title: string | null;
  all_llm_kinds: string;       // comma-joined kinds across duplicate LLM rows for this (orig, clar)
  duplicate_count: number;     // number of LLM rows for this (orig, clar) — 1 means no dup
}

const MAX_DISPLAY_CHARS = 1500;  // matches MAX_CONTENT_CHARS in llm-extractor

function loadUnlabeledPairs(
  db: import('better-sqlite3').Database,
  limit: number
): PairRow[] {
  // Dedupe at TWO levels:
  // (1) (orig_prompt_id, clar_prompt_id) — same pair appearing under multiple rule kinds
  // (2) (session_id, orig.normalized_content, clar.normalized_content) — different prompt_ids
  //     with identical content (Claude Code replay-event artifact; see NOTES.md)
  //
  // Pick the highest-confidence LLM verdict as the representative.
  // Surface duplicate_count and all_llm_kinds so conflicts are visible in TUI.
  return db.prepare(`
    WITH llm_with_content AS (
      SELECT
        cp_llm.pair_id,
        cp_llm.originating_prompt_id,
        cp_llm.clarifying_prompt_id,
        cp_llm.session_id,
        cp_llm.clarification_kind,
        cp_llm.clarification_text,
        cp_llm.confidence,
        cp_llm.reason,
        orig.normalized_content AS orig_norm,
        clar.normalized_content AS clar_norm
      FROM clarifying_pairs cp_llm
      JOIN prompts orig ON orig.prompt_id = cp_llm.originating_prompt_id
      JOIN prompts clar ON clar.prompt_id = cp_llm.clarifying_prompt_id
      WHERE cp_llm.extraction_method = 'llm'
    ),
    ranked AS (
      SELECT *,
        ROW_NUMBER() OVER (
          PARTITION BY session_id, COALESCE(orig_norm, ''), COALESCE(clar_norm, '')
          ORDER BY confidence DESC, pair_id
        ) AS rn
      FROM llm_with_content
    ),
    dup_info AS (
      SELECT
        session_id, COALESCE(orig_norm, '') AS orig_norm, COALESCE(clar_norm, '') AS clar_norm,
        COUNT(*) AS duplicate_count,
        GROUP_CONCAT(DISTINCT clarification_kind) AS all_llm_kinds
      FROM llm_with_content
      GROUP BY session_id, orig_norm, clar_norm
    )
    SELECT
      r.pair_id AS llm_pair_id,
      r.originating_prompt_id,
      r.clarifying_prompt_id,
      r.session_id,
      r.clarification_kind AS llm_kind,
      r.clarification_text AS llm_text,
      r.confidence AS llm_confidence,
      r.reason AS llm_reason,
      cp_rule.clarification_kind AS rule_kind,
      cp_rule.clarification_text AS rule_text,
      orig.content AS orig_content,
      orig.turn_index AS orig_turn,
      clar.content AS clar_content,
      clar.turn_index AS clar_turn,
      p.name AS project_name,
      s.title AS session_title,
      d.all_llm_kinds AS all_llm_kinds,
      d.duplicate_count AS duplicate_count
    FROM ranked r
    JOIN prompts orig ON orig.prompt_id = r.originating_prompt_id
    JOIN prompts clar ON clar.prompt_id = r.clarifying_prompt_id
    JOIN sessions s ON s.session_id = r.session_id
    JOIN projects p ON p.project_id = orig.project_id
    JOIN dup_info d
      ON d.session_id = r.session_id
      AND d.orig_norm = COALESCE(r.orig_norm, '')
      AND d.clar_norm = COALESCE(r.clar_norm, '')
    LEFT JOIN clarifying_pairs cp_rule
      ON cp_rule.originating_prompt_id = r.originating_prompt_id
      AND cp_rule.clarifying_prompt_id = r.clarifying_prompt_id
      AND cp_rule.extraction_method = 'rule'
      AND cp_rule.confidence = (
        SELECT MAX(confidence) FROM clarifying_pairs cp2
        WHERE cp2.extraction_method = 'rule'
          AND cp2.originating_prompt_id = r.originating_prompt_id
          AND cp2.clarifying_prompt_id = r.clarifying_prompt_id
      )
    WHERE r.rn = 1
      AND ${EXCLUDED_PROJECT_CLAUSE}
      AND NOT EXISTS (
        -- Any manual label on a content-equivalent pair in same session counts as "labeled"
        SELECT 1 FROM clarifying_pairs cp_man
        JOIN prompts m_orig ON m_orig.prompt_id = cp_man.originating_prompt_id
        JOIN prompts m_clar ON m_clar.prompt_id = cp_man.clarifying_prompt_id
        WHERE cp_man.extraction_method = 'manual'
          AND cp_man.session_id = r.session_id
          AND COALESCE(m_orig.normalized_content, '') = COALESCE(r.orig_norm, '')
          AND COALESCE(m_clar.normalized_content, '') = COALESCE(r.clar_norm, '')
      )
    ORDER BY r.pair_id
    LIMIT ?
  `).all(limit) as PairRow[];
}

function countAlreadyLabeled(db: import('better-sqlite3').Database): {
  total: number; accepted: number; rejected: number; remaining: number; goldTotal: number;
} {
  const labeled = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN clarification_kind IS NOT NULL THEN 1 ELSE 0 END) AS accepted,
      SUM(CASE WHEN clarification_kind IS NULL THEN 1 ELSE 0 END) AS rejected
    FROM clarifying_pairs
    WHERE extraction_method = 'manual' AND extractor_version = ?
  `).get(LABELER_VERSION) as { total: number; accepted: number; rejected: number };

  // Total gold pool = content-deduped LLM-accepted tuples, MINUS excluded self-ref projects.
  // (session_id, orig_norm, clar_norm) is the unique key — catches replay-duplicates.
  const uniqLlmCount = (db.prepare(`
    SELECT COUNT(DISTINCT cp.session_id || '|' || COALESCE(orig.normalized_content, '') || '|' || COALESCE(clar.normalized_content, '')) AS c
    FROM clarifying_pairs cp
    JOIN prompts orig ON orig.prompt_id = cp.originating_prompt_id
    JOIN prompts clar ON clar.prompt_id = cp.clarifying_prompt_id
    JOIN prompts pr ON pr.prompt_id = cp.originating_prompt_id
    JOIN projects p ON p.project_id = pr.project_id
    WHERE cp.extraction_method='llm'
      AND ${EXCLUDED_PROJECT_CLAUSE}
  `).get() as { c: number }).c;

  // Manual labels also content-deduped. A label on ANY content-equivalent pair counts once.
  const eligibleLabeled = db.prepare(`
    WITH manual_dedup AS (
      SELECT
        cp.session_id,
        COALESCE(orig.normalized_content, '') AS orig_norm,
        COALESCE(clar.normalized_content, '') AS clar_norm,
        MAX(cp.clarification_kind) AS clarification_kind   -- NULL if any rejection, but accepts win on coalesce
      FROM clarifying_pairs cp
      JOIN prompts orig ON orig.prompt_id = cp.originating_prompt_id
      JOIN prompts clar ON clar.prompt_id = cp.clarifying_prompt_id
      JOIN projects p ON p.project_id = orig.project_id
      WHERE cp.extraction_method = 'manual' AND cp.extractor_version = ?
        AND ${EXCLUDED_PROJECT_CLAUSE}
      GROUP BY cp.session_id, orig_norm, clar_norm
    )
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN clarification_kind IS NOT NULL THEN 1 ELSE 0 END) AS accepted,
      SUM(CASE WHEN clarification_kind IS NULL THEN 1 ELSE 0 END) AS rejected
    FROM manual_dedup
  `).get(LABELER_VERSION) as { total: number; accepted: number; rejected: number };

  return {
    total: eligibleLabeled.total || 0,
    accepted: eligibleLabeled.accepted || 0,
    rejected: eligibleLabeled.rejected || 0,
    remaining: uniqLlmCount - (eligibleLabeled.total || 0),
    goldTotal: uniqLlmCount,
  };
}

/**
 * Load conversation context around a pair — used by the [c] command.
 * Returns turns from (orig_turn - lookback) up to clar_turn, inclusive.
 */
function loadContext(
  db: import('better-sqlite3').Database,
  sessionId: string, origTurn: number, clarTurn: number, lookback = 5
): Array<{ turn_index: number; role: string; content: string }> {
  return db.prepare(`
    SELECT turn_index, role, content
    FROM prompts
    WHERE session_id = ? AND turn_index >= ? AND turn_index <= ?
    ORDER BY turn_index
  `).all(sessionId, Math.max(0, origTurn - lookback), clarTurn) as
    Array<{ turn_index: number; role: string; content: string }>;
}

// ============================================================================
// Rendering
// ============================================================================

function wrap(text: string, indent = 4, width = 90): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  const lines: string[] = [];
  let line = '';
  const pad = ' '.repeat(indent);
  for (const word of cleaned.split(' ')) {
    if ((line + ' ' + word).trim().length > width - indent) {
      lines.push(pad + line.trim());
      line = word;
    } else {
      line += ' ' + word;
    }
  }
  if (line.trim()) lines.push(pad + line.trim());
  return lines.join('\n');
}

/**
 * Truncate to N chars matching what the LLM saw. Show an explicit indicator
 * with the omitted byte count so the labeler knows there's more.
 */
function truncateForDisplay(text: string, max = MAX_DISPLAY_CHARS): { shown: string; truncated: boolean; omitted: number } {
  if (text.length <= max) return { shown: text, truncated: false, omitted: 0 };
  return { shown: text.slice(0, max), truncated: true, omitted: text.length - max };
}

function renderPair(pair: PairRow, idxInSession: number, totalInSession: number, progress: ReturnType<typeof countAlreadyLabeled>): string {
  const lines: string[] = [];
  const project = pair.project_name || 'unknown';
  const headerTitle = `Prompt Guard hand-label TUI`;
  const idxLabel = `Pair ${pair.llm_pair_id} · session ${idxInSession + 1}/${totalInSession} · gold so far ${progress.total}/${progress.goldTotal}`;
  const hr = chalk.gray('─'.repeat(90));

  lines.push(chalk.bold.cyan(headerTitle) + chalk.gray('  —  ') + chalk.gray(idxLabel));
  lines.push(hr);
  lines.push(chalk.bold(`${project}`) + chalk.gray(`   session ${pair.session_id.slice(0, 12)}…   turns ${pair.orig_turn}→${pair.clar_turn}`));
  lines.push('');

  const origTrunc = truncateForDisplay(pair.orig_content);
  lines.push(chalk.bold('ORIG') + chalk.gray(` (turn ${pair.orig_turn}):`));
  lines.push(wrap(origTrunc.shown, 4, 90));
  if (origTrunc.truncated) lines.push(chalk.gray(`    [+ ${origTrunc.omitted} more chars in DB; LLM saw same ${MAX_DISPLAY_CHARS} chars]`));
  lines.push('');

  const clarTrunc = truncateForDisplay(pair.clar_content);
  lines.push(chalk.bold('CLAR') + chalk.gray(` (turn ${pair.clar_turn}):`));
  lines.push(wrap(clarTrunc.shown, 4, 90));
  if (clarTrunc.truncated) lines.push(chalk.gray(`    [+ ${clarTrunc.omitted} more chars in DB; LLM saw same ${MAX_DISPLAY_CHARS} chars]`));
  lines.push('');

  lines.push(hr);
  lines.push(chalk.bold('LLM verdict'));

  // Kind label — flag if rule was refined OR if LLM had conflicting verdicts across duplicates
  const kinds = pair.all_llm_kinds.split(',').map(s => s.trim()).filter(Boolean);
  const hasKindConflict = pair.duplicate_count > 1 && kinds.length > 1;
  let kindLabel: string;
  if (hasKindConflict) {
    const others = kinds.filter(k => k !== pair.llm_kind);
    kindLabel = chalk.red(pair.llm_kind) + chalk.red(`  ⚠ LLM CONFLICT — other verdicts: ${others.join(', ')}`);
  } else if (pair.llm_kind === pair.rule_kind) {
    kindLabel = chalk.green(pair.llm_kind) + chalk.gray(' (matches rule)');
  } else {
    kindLabel = chalk.yellow(pair.llm_kind) + chalk.gray(` (refined from rule's ${pair.rule_kind})`);
  }
  lines.push(`  kind:        ${kindLabel}`);
  lines.push(`  text:        ${chalk.cyan('"' + pair.llm_text + '"')}`);
  lines.push(`  confidence:  ${pair.llm_confidence.toFixed(2)}` + (pair.duplicate_count > 1 ? chalk.gray(`  (showing highest of ${pair.duplicate_count} duplicate LLM rows)`) : ''));
  if (pair.llm_reason) {
    lines.push(`  reason:`);
    lines.push(chalk.gray(wrap(pair.llm_reason, 4, 90)));
  } else {
    lines.push(chalk.gray('  reason:      (not captured — run `prompt-guard backfill-reasons` to fill in)'));
  }

  if (pair.rule_kind && pair.rule_text) {
    lines.push('');
    lines.push(chalk.gray('Rule extractor said:'));
    const ruleTrunc = pair.rule_text.length > 140 ? pair.rule_text.slice(0, 140) + '…' : pair.rule_text;
    lines.push(chalk.gray(`  kind=${pair.rule_kind}, text="${ruleTrunc}"`));
  }

  lines.push('');
  lines.push(chalk.bold('Progress:') + chalk.gray(`   total labeled: ${progress.total} · accepted: ${progress.accepted} · rejected: ${progress.rejected} · remaining: ${progress.remaining}`));
  lines.push('');
  lines.push(
    chalk.green('[a]') + 'ccept   ' +
    chalk.red('[r]') + 'eject   ' +
    chalk.yellow('[e]') + 'dit-text   ' +
    chalk.yellow('[k]') + '-fix-kind   ' +
    chalk.cyan('[c]') + 'ontext   ' +
    chalk.gray('[s]') + 'kip   ' +
    chalk.gray('[q]') + 'uit-and-save'
  );
  lines.push(chalk.gray('> ') + chalk.gray('waiting for keypress…'));

  return lines.join('\n');
}

function renderKindMenu(currentKind: string): string {
  const lines = [chalk.bold('Pick new kind:')];
  KINDS.forEach((k, i) => {
    const marker = k === currentKind ? chalk.cyan('●') : ' ';
    lines.push(`  [${i + 1}] ${marker} ${k}`);
  });
  lines.push(`  [c]   cancel`);
  lines.push(chalk.gray('> '));
  return lines.join('\n');
}

// ============================================================================
// I/O helpers
// ============================================================================

function clearScreen(): void {
  process.stdout.write('\x1B[2J\x1B[H');
}

async function readKey(): Promise<string> {
  return new Promise(resolve => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const onData = (data: string): void => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
      // Ctrl-C handling
      if (data === '') {
        console.log('\n' + chalk.yellow('Interrupted. Progress saved.'));
        process.exit(0);
      }
      resolve(data);
    };
    process.stdin.on('data', onData);
  });
}

function editInExternalEditor(initial: string): string {
  const editor = process.env.EDITOR || 'vi';
  const tmpFile = path.join(os.tmpdir(), `pg-edit-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, initial);
  try {
    execSync(`${editor} "${tmpFile}"`, { stdio: 'inherit' });
    const result = fs.readFileSync(tmpFile, 'utf-8').trim();
    return result;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

// ============================================================================
// Main loop
// ============================================================================

export async function runLabelGold(opts: LabelGoldOptions = {}): Promise<void> {
  const dbPath = opts.dbPath || DEFAULT_DB_PATH;
  const db = openDb({ dbPath });

  const limit = opts.limit ?? 1000;
  const pairs = loadUnlabeledPairs(db, limit);

  if (pairs.length === 0) {
    console.log(chalk.green('All LLM-accepted pairs are already labeled.'));
    db.close();
    return;
  }

  if (opts.preview) {
    // Static render of the first N pairs for UX sanity-check
    const progress = countAlreadyLabeled(db);
    const n = Math.min(opts.limit ?? 3, pairs.length);
    console.log(chalk.bold(`Preview mode: rendering first ${n} pair(s). No DB writes.`));
    console.log('');
    for (let i = 0; i < n; i++) {
      console.log(renderPair(pairs[i], i, pairs.length, progress));
      console.log('');
      console.log(chalk.gray('═'.repeat(90)));
      console.log('');
    }
    db.close();
    return;
  }

  // Interactive loop
  const insertManual = db.prepare(`
    INSERT INTO clarifying_pairs (
      originating_prompt_id, clarifying_prompt_id, session_id,
      clarification_text, clarification_kind,
      extraction_method, extractor_version, confidence,
      extracted_at, is_in_gold_subset, reason
    ) VALUES (?, ?, ?, ?, ?, 'manual', ?, NULL, ?, 1, ?)
  `);

  let idx = 0;
  while (idx < pairs.length) {
    const pair = pairs[idx];
    const progress = countAlreadyLabeled(db);

    // Effective kind + text after potential edits this turn
    let currentKind: string | null = pair.llm_kind;
    let currentText: string = pair.llm_text;
    let action: 'accept' | 'reject' | 'skip' | 'quit' | null = null;
    let reason: string | null = null;

    while (action === null) {
      clearScreen();
      // Render with possibly-edited values
      const renderPairWithEdits: PairRow = { ...pair, llm_kind: currentKind || pair.llm_kind, llm_text: currentText };
      console.log(renderPair(renderPairWithEdits, idx, pairs.length, progress));

      const key = (await readKey()).toLowerCase();

      if (key === 'a') action = 'accept';
      else if (key === 'r') {
        process.stdout.write(chalk.gray('reject reason (optional, enter to skip): '));
        process.stdin.setRawMode(false);
        process.stdin.resume();
        const line = await new Promise<string>(res => {
          let buf = '';
          const onData = (chunk: string): void => {
            buf += chunk;
            if (buf.includes('\n')) {
              process.stdin.removeListener('data', onData);
              process.stdin.pause();
              res(buf.replace(/\n.*/, ''));
            }
          };
          process.stdin.setEncoding('utf8');
          process.stdin.on('data', onData);
        });
        reason = line.trim() || null;
        action = 'reject';
      }
      else if (key === 'e') {
        currentText = editInExternalEditor(currentText);
      }
      else if (key === 'k') {
        clearScreen();
        console.log(renderKindMenu(currentKind || 'file-scope'));
        const k = (await readKey()).toLowerCase();
        if (k >= '1' && k <= '6') currentKind = KINDS[parseInt(k, 10) - 1];
        // 'x' or anything else → cancel
      }
      else if (key === 'c') {
        // Show 5 turns before ORIG up through CLAR for situational context
        clearScreen();
        const ctx = loadContext(db, pair.session_id, pair.orig_turn, pair.clar_turn, 5);
        console.log(chalk.bold.cyan(`Context — ${pair.session_id.slice(0, 12)}… · turns ${ctx[0]?.turn_index}-${ctx[ctx.length-1]?.turn_index}`));
        console.log(chalk.gray('─'.repeat(90)));
        for (const t of ctx) {
          const isOrig = t.turn_index === pair.orig_turn;
          const isClar = t.turn_index === pair.clar_turn;
          const tag = isOrig ? chalk.green(' ◀── ORIG')
                    : isClar ? chalk.yellow(' ◀── CLAR') : '';
          const rolePad = t.role === 'user' ? chalk.bold.cyan('user') : chalk.bold('asst');
          console.log(`\n${chalk.gray(`[turn ${t.turn_index}]`)} ${rolePad}${tag}`);
          const preview = t.content.replace(/\s+/g, ' ').slice(0, 600);
          console.log(chalk.gray(wrap(preview, 4, 90)));
          if (t.content.length > 600) console.log(chalk.gray(`    [+ ${t.content.length - 600} more chars]`));
        }
        console.log('');
        console.log(chalk.gray('Press any key to return to the labeling view…'));
        await readKey();
        // loop re-renders the pair
      }
      else if (key === 's') action = 'skip';
      else if (key === 'q') action = 'quit';
      // any other key: just re-render
    }

    if (action === 'accept') {
      insertManual.run(
        pair.originating_prompt_id, pair.clarifying_prompt_id, pair.session_id,
        currentText, currentKind, LABELER_VERSION,
        new Date().toISOString(), null
      );
      idx += 1;
    } else if (action === 'reject') {
      insertManual.run(
        pair.originating_prompt_id, pair.clarifying_prompt_id, pair.session_id,
        REJECT_MARKER, null, LABELER_VERSION,
        new Date().toISOString(), reason
      );
      idx += 1;
    } else if (action === 'skip') {
      idx += 1;
    } else if (action === 'quit') {
      break;
    }
  }

  clearScreen();
  const final = countAlreadyLabeled(db);
  console.log(chalk.bold.green('Session ended.'));
  console.log(`  Labeled this session: ${idx}`);
  console.log(`  Total labeled:        ${final.total}/${final.goldTotal}  (${final.accepted} accepted, ${final.rejected} rejected)`);
  console.log(`  Remaining:            ${final.remaining}`);
  console.log('');
  if (final.remaining === 0) {
    console.log(chalk.bold.green('Gold subset complete. Ready for MVP-4 eval harness.'));
  } else {
    console.log(chalk.gray('Run `prompt-guard label-gold` again to resume.'));
  }

  db.close();
}
