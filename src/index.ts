import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';
import chalk from 'chalk';
import type { ContextFile, CheckResult, CheckContext } from './checks/types';
import type { Config } from './config-types';
import { buildPipeline } from './checks/registry';

// Re-export for backward compat with existing consumers
export type { ContextFile, CheckResult, CheckContext, Check } from './checks/types';
export type { Config } from './config-types';
export { ALL_CHECKS, buildPipeline } from './checks/registry';

export class PromptGuard {
  private config: Config;
  private contextCache: Map<string, string> = new Map();

  constructor(config?: Partial<Config>, projectPath: string = process.cwd()) {
    // Load config from .prompt-guard.json if it exists
    const fileConfig = this.loadFileConfig(projectPath);
    
    this.config = {
      contextFiles: ['PROJECT.md', 'SOUL.md', 'AGENTS.md', 'CONTEXT.md', 'README.md'],
      enabledChecks: ['files-mentioned', 'tests-mentioned', 'success-criteria', 'constraints', 'local-env', 'context-window'],
      autoInject: true,
      confirmBeforeSend: true,
      maxContextTokens: 4000, // Default: leave room for response
      modelLimits: {
        'claude': 100000,
        'claude-opus': 200000,
        'gpt-4': 8000,
        'gpt-4-turbo': 128000,
        'cursor': 8000
      },
      ...fileConfig,
      ...config
    };
  }

  /**
   * Load configuration from .prompt-guard.json file
   */
  private loadFileConfig(projectPath: string): Partial<Config> {
    const configPath = path.join(projectPath, '.prompt-guard.json');
    
    if (fs.existsSync(configPath)) {
      try {
        const content = fs.readFileSync(configPath, 'utf-8');
        return JSON.parse(content);
      } catch (e) {
        console.warn(chalk.yellow('⚠ Failed to parse .prompt-guard.json, using defaults'));
      }
    }
    
    return {};
  }

  /**
   * Load context from .md files in project root
   * Filters out local environment specifics to prevent overfitting
   */
  async loadContext(projectPath: string = process.cwd()): Promise<ContextFile[]> {
    const contextFiles: ContextFile[] = [];

    for (const fileName of this.config.contextFiles) {
      const filePath = path.join(projectPath, fileName);

      if (fs.existsSync(filePath)) {
        let content = fs.readFileSync(filePath, 'utf-8');

        // Sanitize content to remove local environment specifics
        content = this.sanitizeLocalEnv(content);

        this.contextCache.set(fileName, content);

        contextFiles.push({
          name: fileName,
          content: this.truncateContent(content, 2000),
          relevance: this.calculateRelevance(fileName)
        });
      }
    }

    return contextFiles;
  }

  /**
   * Remove local environment specifics that cause overfitting
   */
  private sanitizeLocalEnv(content: string): string {
    // Remove absolute paths
    content = content.replace(/\/Users\/\w+|\/home\/\w+|C:\\Users\\\w+/g, '<USER_HOME>');

    // Remove local ports (keep common ones like 3000, 8080 as examples)
    content = content.replace(/localhost:\d{4,5}/g, (match) => {
      const port = parseInt(match.split(':')[1]);
      // Keep common ports as examples, redact others
      if ([3000, 3001, 8080, 8000].includes(port)) {
        return match;
      }
      return 'localhost:<PORT>';
    });

    // Remove API keys and tokens
    content = content.replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*['"\w-]+/gi, '$1: <REDACTED>');

    // Remove local file paths but keep relative ones
    content = content.replace(/\/\w+\/\w+\/[^\s]+\.(js|ts|json|md)/g, (match) => {
      // Keep relative paths (starting with ./ or ../ or src/)
      if (match.startsWith('./') || match.startsWith('../') || match.startsWith('src/')) {
        return match;
      }
      return '<LOCAL_PATH>';
    });

    // Remove machine-specific config
    content = content.replace(/(hostname|computer name|machine|device):\s*\w+/gi, '$1: <MACHINE>');

    return content;
  }

  /**
   * Check a prompt for missing context.
   *
   * Builds a CheckContext and runs each check in the registry whose id is
   * listed in `config.enabledChecks`. Previously this method ignored that
   * config field and ran a hardcoded sequence — fixed in MVP-2.
   */
  async check(promptText: string): Promise<CheckResult[]> {
    const ctx = await this.buildCheckContext(promptText);
    const pipeline = buildPipeline(this.config.enabledChecks);
    const results: CheckResult[] = [];
    for (const check of pipeline) {
      // Gate on requirements. corpus-clarify requires ctx.corpus; until MVP-3
      // wires the CorpusReader, ctx.corpus is undefined and the check is skipped.
      if (check.requires === 'corpus' && !ctx.corpus) continue;
      if (check.requires === 'context-files' && ctx.contextFiles.length === 0) continue;
      results.push(...await check.run(ctx));
    }
    return results;
  }

  /** Build a CheckContext for the registry pipeline. */
  private async buildCheckContext(promptText: string): Promise<CheckContext> {
    const contextFiles = await this.loadContext();
    const promptTokens = this.estimateTokens(promptText);
    const contextTokens = contextFiles.reduce((sum, f) => sum + this.estimateTokens(f.content), 0);
    return {
      prompt: promptText,
      promptTokens,
      contextFiles,
      contextTokens,
      config: this.config,
      // corpus + projectId: undefined for MVP-2; wired in MVP-3
      corpus: undefined,
      projectId: undefined,
    };
  }

  /**
   * Enhance prompt with context from .md files
   * Respects context window limits
   */
  async enhance(promptText: string): Promise<string> {
    let contextFiles = await this.loadContext();

    if (contextFiles.length === 0) {
      console.log(chalk.yellow('No context files found. Run `prompt-guard init` to create them.'));
      return promptText;
    }

    // Check context window and truncate if needed
    const promptTokens = this.estimateTokens(promptText);
    const instructionsTokens = 100; // Approximate
    let availableTokens = this.config.maxContextTokens - promptTokens - instructionsTokens;

    // Sort by relevance and truncate if needed
    contextFiles.sort((a, b) => b.relevance - a.relevance);

    let totalContextTokens = 0;
    const includedFiles: ContextFile[] = [];

    for (const file of contextFiles) {
      const fileTokens = this.estimateTokens(file.content);

      if (totalContextTokens + fileTokens <= availableTokens) {
        includedFiles.push(file);
        totalContextTokens += fileTokens;
      } else {
        // Try to truncate this file to fit
        const remainingTokens = availableTokens - totalContextTokens;
        if (remainingTokens > 500) { // Only include if we can fit meaningful content
          const truncatedContent = this.truncateContent(file.content, remainingTokens * 4);
          includedFiles.push({
            ...file,
            content: truncatedContent + '\n... (truncated due to context limit)'
          });
          totalContextTokens += remainingTokens;
        }
        break;
      }
    }

    if (includedFiles.length < contextFiles.length && includedFiles.length > 0) {
      console.log(chalk.yellow(`⚠ Context truncated: using ${includedFiles.length}/${contextFiles.length} files to fit context window`));
    } else if (includedFiles.length === 0 && contextFiles.length > 0) {
      console.log(chalk.yellow(`⚠ Context window too small: no context files included. Increase maxContextTokens or shorten prompt.`));
    }

    let enhancedPrompt = '';

    // Add context header only if we have context
    if (includedFiles.length > 0) {
      enhancedPrompt += `## Project Context\n\n`;
    }

    for (const file of includedFiles) {
      enhancedPrompt += `### From ${file.name}:\n${file.content}\n\n`;
    }

    // Add the original prompt
    enhancedPrompt += `## User Request\n\n${promptText}\n\n`;

    // Add instructions for the AI
    enhancedPrompt += `## Instructions\n\n`;
    if (includedFiles.length > 0) {
      enhancedPrompt += `- Consider the project context above\n`;
      enhancedPrompt += `- Follow any patterns or conventions mentioned\n`;
      enhancedPrompt += `- If tests are mentioned in context, include them\n`;
      enhancedPrompt += `- Respect any constraints from the context files\n`;
    } else {
      enhancedPrompt += `- No project context available — ask for clarification if needed\n`;
      enhancedPrompt += `- Follow general best practices\n`;
    }

    return enhancedPrompt;
  }

  /**
   * Display check results with formatting
   */
  displayResults(results: CheckResult[]): void {
    if (results.length === 0) {
      console.log(chalk.green('✓ All checks passed!'));
      return;
    }
    
    console.log(chalk.bold('\nPrompt Analysis:\n'));
    
    for (const result of results) {
      const icon = result.type === 'error' ? '✗' : result.type === 'warning' ? '⚠' : 'ℹ';
      const color = result.type === 'error' ? chalk.red : result.type === 'warning' ? chalk.yellow : chalk.blue;
      
      console.log(color(`${icon} ${result.message}`));
      if (result.suggestion) {
        console.log(chalk.gray(`  → ${result.suggestion}`));
      }
    }
    
    console.log('');
  }

  /**
   * Initialize prompt-guard in current project
   */
  async init(): Promise<void> {
    const projectPath = process.cwd();
    
    console.log(chalk.bold('Initializing prompt-guard...\n'));
    
    // Create PROJECT.md template
    const projectMdPath = path.join(projectPath, 'PROJECT.md');
    if (!fs.existsSync(projectMdPath)) {
      fs.writeFileSync(projectMdPath, this.getProjectTemplate());
      console.log(chalk.green('✓ Created PROJECT.md'));
    } else {
      console.log(chalk.yellow('⚠ PROJECT.md already exists'));
    }
    
    // Create CONTEXT.md template
    const contextMdPath = path.join(projectPath, 'CONTEXT.md');
    if (!fs.existsSync(contextMdPath)) {
      fs.writeFileSync(contextMdPath, this.getContextTemplate());
      console.log(chalk.green('✓ Created CONTEXT.md'));
    } else {
      console.log(chalk.yellow('⚠ CONTEXT.md already exists'));
    }
    
    console.log(chalk.bold('\nNext steps:'));
    console.log('1. Edit PROJECT.md with your project details');
    console.log('2. Edit CONTEXT.md with coding conventions');
    console.log('3. Run `prompt-guard check "your prompt"` to test');
  }

  /**
   * Show prompt and context statistics
   */
  async showStats(promptText?: string): Promise<void> {
    const contextFiles = await this.loadContext();

    console.log(chalk.bold('\nPrompt Guard Statistics\n'));

    // Context files section
    console.log(chalk.bold('Context Files:'));
    if (contextFiles.length === 0) {
      console.log(chalk.yellow('  No context files found. Run `prompt-guard init` to create them.'));
    } else {
      let totalContextChars = 0;
      let totalContextTokens = 0;
      for (const file of contextFiles) {
        const chars = file.content.length;
        const tokens = this.estimateTokens(file.content);
        totalContextChars += chars;
        totalContextTokens += tokens;
        const bar = chalk.green('█'.repeat(Math.round(file.relevance * 10)));
        console.log(`  ${chalk.cyan(file.name.padEnd(14))} ${bar} relevance: ${file.relevance.toFixed(1)}  ${chars} chars  ~${tokens} tokens`);
      }
      console.log(chalk.gray(`  Total: ${contextFiles.length} files, ${totalContextChars} chars, ~${totalContextTokens} tokens`));
    }

    // Token budget section
    console.log('');
    console.log(chalk.bold('Token Budget:'));
    const limit = this.config.maxContextTokens;
    const contextTokens = contextFiles.reduce((sum, f) => sum + this.estimateTokens(f.content), 0);

    if (promptText) {
      const promptTokens = this.estimateTokens(promptText);
      const total = promptTokens + contextTokens;
      const pct = Math.round((total / limit) * 100);
      const barLen = 30;
      const filled = Math.min(Math.round((total / limit) * barLen), barLen);
      const barColor = pct >= 100 ? chalk.red : pct >= 80 ? chalk.yellow : chalk.green;
      const bar = barColor('█'.repeat(filled)) + chalk.gray('░'.repeat(barLen - filled));
      console.log(`  Prompt:    ~${promptTokens} tokens`);
      console.log(`  Context:   ~${contextTokens} tokens`);
      console.log(`  Total:     ~${total} / ${limit} tokens  [${bar}] ${pct}%`);
      if (pct >= 100) console.log(chalk.red('  ✗ Exceeds context limit'));
      else if (pct >= 80) console.log(chalk.yellow('  ⚠ Approaching context limit'));
      else console.log(chalk.green('  ✓ Within context limit'));
    } else {
      const pct = Math.round((contextTokens / limit) * 100);
      console.log(`  Context:   ~${contextTokens} tokens`);
      console.log(`  Limit:     ${limit} tokens  (${pct}% used by context)`);
      console.log(chalk.gray('  Tip: pass a prompt to see full token breakdown'));
    }

    // Checks section
    console.log('');
    console.log(chalk.bold('Enabled Checks:'));
    for (const check of this.config.enabledChecks) {
      console.log(`  ${chalk.green('✓')} ${check}`);
    }
    console.log('');
  }

  /**
   * Show current configuration
   */
  showConfig(): void {
    console.log(chalk.bold('Prompt Guard Configuration:\n'));
    console.log('Context files:', this.config.contextFiles.join(', '));
    console.log('Enabled checks:', this.config.enabledChecks.join(', '));
    console.log('Auto-inject:', this.config.autoInject);
    console.log('Confirm before send:', this.config.confirmBeforeSend);
    console.log('Max context tokens:', this.config.maxContextTokens);
    console.log('Model limits:', Object.keys(this.config.modelLimits).join(', '));
  }

  // Helper methods. The 6 per-check regex/heuristic methods that lived here
  // were extracted to src/corpus/heuristics.ts in MVP-2 and are consumed by
  // the new checks in src/checks/*.ts.

  private calculateRelevance(fileName: string): number {
    const relevanceMap: Record<string, number> = {
      'PROJECT.md': 1.0,
      'CONTEXT.md': 0.9,
      'AGENTS.md': 0.8,
      'SOUL.md': 0.7,
      'README.md': 0.6
    };
    return relevanceMap[fileName] || 0.5;
  }

  private truncateContent(content: string, maxLength: number): string {
    if (content.length <= maxLength) return content;
    return content.substring(0, maxLength) + '\n... (truncated)';
  }

  /**
   * Estimate token count (rough approximation: ~4 chars per token)
   */
  private estimateTokens(text: string): number {
    // Rough estimate: 1 token ≈ 4 characters for English text
    return Math.ceil(text.length / 4);
  }

  private getProjectTemplate(): string {
    return `# Project Context

## Overview
Brief description of what this project does.

## Tech Stack
- Language: 
- Framework: 
- Database: 
- Key Dependencies: 

## Architecture
- Main entry point: 
- Core modules: 
- Testing framework: 

## Coding Conventions
- Style guide: 
- Naming conventions: 
- File organization: 

## Constraints
- Performance requirements: 
- Compatibility requirements: 
- Security considerations: 
`;
  }

  private getContextTemplate(): string {
    return `# Coding Context

## Patterns to Follow
- Always write tests for new features
- Use TypeScript strict mode
- Prefer functional components
- Keep functions under 50 lines

## Things to Avoid
- Don't use any types
- Don't skip error handling
- Don't break existing APIs without versioning

## Testing Requirements
- Unit tests for utilities
- Integration tests for APIs
- E2E tests for critical paths

## Performance Targets
- Page load under 2 seconds
- API response under 200ms
- Bundle size under 100KB
`;
  }
}