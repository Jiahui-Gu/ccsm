/**
 * Read the user's CLI default-model preference from
 * `~/.claude/settings.json`'s top-level `model` field. This is exactly the
 * value the CLI itself consults for `claude --model` defaulting, so reusing
 * it makes ccsm's new-session default match what the user already configured
 * for the CLI — no second source of truth, no frequency vote, no surprise
 * model id that isn't even in the picker list.
 *
 * Returns `null` when settings.json is missing, malformed, or has no `model`
 * field. Never throws.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { getClaudeConfigDir } from '../shared/claudePaths.js';

interface SettingsShape {
  model?: unknown;
}

async function readSettings(configDir: string): Promise<SettingsShape | null> {
  const file = path.join(configDir, 'settings.json');
  let raw: string;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch {
    // ENOENT or permission error — treat as "nothing to merge", not an error.
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as SettingsShape;
    return null;
  } catch {
    // Malformed JSON: ignore so a hand-edited settings.json doesn't break
    // the new-session default. Caller falls through to its own null path.
    return null;
  }
}

export async function readDefaultModelFromSettings(
  configDir?: string,
): Promise<string | null> {
  const dir = configDir ?? getClaudeConfigDir();
  const settings = await readSettings(dir);
  if (!settings) return null;
  if (typeof settings.model !== 'string') return null;
  const trimmed = settings.model.trim();
  return trimmed.length > 0 ? trimmed : null;
}
