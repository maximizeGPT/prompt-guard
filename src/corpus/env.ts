/**
 * Tiny dotenv loader. Reads ~/.env into process.env if relevant keys
 * aren't already set. No external dependency.
 *
 * the developer keeps API keys in ~/.env. His shell does NOT auto-source it,
 * so Node processes need to load it explicitly.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ENV_PATH = path.join(os.homedir(), '.env');

let loaded = false;

/**
 * Load ~/.env into process.env. Idempotent. Existing process.env values win
 * (so explicit `ANTHROPIC_API_KEY=... node ...` overrides ~/.env).
 */
export function loadHomeEnv(): void {
  if (loaded) return;
  loaded = true;

  if (!fs.existsSync(ENV_PATH)) return;

  let content: string;
  try {
    content = fs.readFileSync(ENV_PATH, 'utf-8');
  } catch {
    return;
  }

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // Treat empty string as "not set" — some launchers (Claude Code, MCP
    // hosts) export keys with empty values, which would otherwise prevent
    // ~/.env from filling them in.
    if (key && !process.env[key]) {
      process.env[key] = value;
    }
  }
}
