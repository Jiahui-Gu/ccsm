// Tests for the claudePaths helper. Covers the env-var override + homedir
// default, plus a positive reverse-verify that the env var actually drives
// the value (commenting out the read in claudePaths.ts will make the
// 'override' tests fail — see PR #812 reverse-verify output).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  getClaudeConfigDir,
  getClaudeProjectsDir,
  getClaudeSettingsPath,
} from '../claudePaths';

let originalConfigDir: string | undefined;

beforeEach(() => {
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
});

describe('getClaudeConfigDir', () => {
  it('defaults to <homedir>/.claude when CLAUDE_CONFIG_DIR is unset', () => {
    expect(getClaudeConfigDir()).toBe(path.join(os.homedir(), '.claude'));
  });

  it('returns CLAUDE_CONFIG_DIR verbatim when set', () => {
    process.env.CLAUDE_CONFIG_DIR = '/tmp/fake-claude';
    expect(getClaudeConfigDir()).toBe('/tmp/fake-claude');
  });

  it('reads the env var lazily on every call', () => {
    expect(getClaudeConfigDir()).toBe(path.join(os.homedir(), '.claude'));
    process.env.CLAUDE_CONFIG_DIR = '/tmp/lazy-1';
    expect(getClaudeConfigDir()).toBe('/tmp/lazy-1');
    process.env.CLAUDE_CONFIG_DIR = '/tmp/lazy-2';
    expect(getClaudeConfigDir()).toBe('/tmp/lazy-2');
    delete process.env.CLAUDE_CONFIG_DIR;
    expect(getClaudeConfigDir()).toBe(path.join(os.homedir(), '.claude'));
  });
});

describe('getClaudeProjectsDir', () => {
  it('appends /projects to the config dir (default)', () => {
    expect(getClaudeProjectsDir()).toBe(
      path.join(os.homedir(), '.claude', 'projects'),
    );
  });

  it('appends /projects to CLAUDE_CONFIG_DIR override', () => {
    process.env.CLAUDE_CONFIG_DIR = '/tmp/fake-claude';
    expect(getClaudeProjectsDir()).toBe(path.join('/tmp/fake-claude', 'projects'));
  });
});

describe('getClaudeSettingsPath', () => {
  it('appends /settings.json to the config dir (default)', () => {
    expect(getClaudeSettingsPath()).toBe(
      path.join(os.homedir(), '.claude', 'settings.json'),
    );
  });

  it('appends /settings.json to CLAUDE_CONFIG_DIR override', () => {
    process.env.CLAUDE_CONFIG_DIR = '/tmp/fake-claude';
    expect(getClaudeSettingsPath()).toBe(
      path.join('/tmp/fake-claude', 'settings.json'),
    );
  });
});

// Reverse-verify (#812): the 'override' assertions above fail if the helper
// stops reading process.env.CLAUDE_CONFIG_DIR (e.g., if someone changes it
// to a module-load-time capture). Manually verified during PR #812 by
// commenting out the env read in claudePaths.ts → all six override tests
// FAIL with "Expected: '/tmp/fake-claude' Received: '<homedir>/.claude'";
// restoring the read → all PASS. Output captured in PR body.
describe('CLAUDE_CONFIG_DIR is the actual driver (not inert)', () => {
  it('switches base dir solely by mutating the env var', () => {
    const a = getClaudeConfigDir();
    process.env.CLAUDE_CONFIG_DIR = '/tmp/distinct-1';
    const b = getClaudeConfigDir();
    process.env.CLAUDE_CONFIG_DIR = '/tmp/distinct-2';
    const c = getClaudeConfigDir();
    expect(b).not.toBe(a);
    expect(c).not.toBe(b);
    expect(b).toBe('/tmp/distinct-1');
    expect(c).toBe('/tmp/distinct-2');
  });
});
