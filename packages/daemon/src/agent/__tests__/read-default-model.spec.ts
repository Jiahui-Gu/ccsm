// packages/daemon/src/agent/__tests__/read-default-model.spec.ts
//
// Unit tests for `readDefaultModelFromSettings` (Task #436 coverage sweep).
// Pure-fs helper that reads `<configDir>/settings.json` and returns the
// `model` field — covers: missing file, malformed JSON, missing field,
// non-string field, empty/whitespace string, valid value, env-var path.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readDefaultModelFromSettings } from '../read-default-model.js';

let tmpDir: string;
let originalEnv: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ccsm-read-default-model-'));
  originalEnv = process.env.CLAUDE_CONFIG_DIR;
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalEnv;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('readDefaultModelFromSettings', () => {
  it('returns null when configDir does not exist', async () => {
    const missing = join(tmpDir, 'does-not-exist');
    expect(await readDefaultModelFromSettings(missing)).toBeNull();
  });

  it('returns null when settings.json is missing', async () => {
    expect(await readDefaultModelFromSettings(tmpDir)).toBeNull();
  });

  it('returns null when settings.json is malformed JSON', async () => {
    writeFileSync(join(tmpDir, 'settings.json'), '{not json', 'utf8');
    expect(await readDefaultModelFromSettings(tmpDir)).toBeNull();
  });

  it('returns null when JSON parses to a non-object (string root)', async () => {
    writeFileSync(join(tmpDir, 'settings.json'), '"just a string"', 'utf8');
    expect(await readDefaultModelFromSettings(tmpDir)).toBeNull();
  });

  it('returns null when JSON parses to null', async () => {
    writeFileSync(join(tmpDir, 'settings.json'), 'null', 'utf8');
    expect(await readDefaultModelFromSettings(tmpDir)).toBeNull();
  });

  it('returns null when the model field is absent', async () => {
    writeFileSync(join(tmpDir, 'settings.json'), JSON.stringify({ theme: 'dark' }), 'utf8');
    expect(await readDefaultModelFromSettings(tmpDir)).toBeNull();
  });

  it('returns null when the model field is not a string', async () => {
    writeFileSync(join(tmpDir, 'settings.json'), JSON.stringify({ model: 42 }), 'utf8');
    expect(await readDefaultModelFromSettings(tmpDir)).toBeNull();
  });

  it('returns null when the model field is an empty string', async () => {
    writeFileSync(join(tmpDir, 'settings.json'), JSON.stringify({ model: '' }), 'utf8');
    expect(await readDefaultModelFromSettings(tmpDir)).toBeNull();
  });

  it('returns null when the model field is whitespace only', async () => {
    writeFileSync(join(tmpDir, 'settings.json'), JSON.stringify({ model: '   ' }), 'utf8');
    expect(await readDefaultModelFromSettings(tmpDir)).toBeNull();
  });

  it('returns the trimmed model string when valid', async () => {
    writeFileSync(
      join(tmpDir, 'settings.json'),
      JSON.stringify({ model: '  claude-sonnet-4.5  ' }),
      'utf8',
    );
    expect(await readDefaultModelFromSettings(tmpDir)).toBe('claude-sonnet-4.5');
  });

  it('returns the model string verbatim (no trimming) when no surrounding whitespace', async () => {
    writeFileSync(
      join(tmpDir, 'settings.json'),
      JSON.stringify({ model: 'claude-haiku-4.5' }),
      'utf8',
    );
    expect(await readDefaultModelFromSettings(tmpDir)).toBe('claude-haiku-4.5');
  });

  it('falls back to CLAUDE_CONFIG_DIR / homedir when configDir is omitted', async () => {
    // Point CLAUDE_CONFIG_DIR at our tmpDir and call WITHOUT the explicit
    // configDir argument so the helper exercises `getClaudeConfigDir()`.
    const subDir = join(tmpDir, 'env-config');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(
      join(subDir, 'settings.json'),
      JSON.stringify({ model: 'claude-opus-4.7' }),
      'utf8',
    );
    process.env.CLAUDE_CONFIG_DIR = subDir;
    expect(await readDefaultModelFromSettings()).toBe('claude-opus-4.7');
  });
});
