import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveClaudeBinary } from '../binary-resolver';

// We test against the real `where` (Windows) / `which` (POSIX) command on
// PATH. Tests that need a guaranteed hit use AGENTORY_CLAUDE_BIN with a
// throwaway file in tmpdir.

const ORIGINAL_OVERRIDE = process.env.AGENTORY_CLAUDE_BIN;

describe('resolveClaudeBinary', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentory-resolver-'));
    delete process.env.AGENTORY_CLAUDE_BIN;
  });

  afterEach(() => {
    if (ORIGINAL_OVERRIDE === undefined) {
      delete process.env.AGENTORY_CLAUDE_BIN;
    } else {
      process.env.AGENTORY_CLAUDE_BIN = ORIGINAL_OVERRIDE;
    }
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('returns the AGENTORY_CLAUDE_BIN override when it points at an existing file', async () => {
    const fake = join(tmpDir, process.platform === 'win32' ? 'claude.cmd' : 'claude');
    writeFileSync(fake, '#!/bin/sh\necho fake');
    process.env.AGENTORY_CLAUDE_BIN = fake;

    const got = await resolveClaudeBinary();
    expect(got).toBe(fake);
    expect(existsSync(got)).toBe(true);
  });

  it('throws when AGENTORY_CLAUDE_BIN points at a non-existent path', async () => {
    process.env.AGENTORY_CLAUDE_BIN = join(tmpDir, 'does-not-exist');
    await expect(resolveClaudeBinary()).rejects.toThrow(
      /AGENTORY_CLAUDE_BIN/
    );
  });

  it('throws an install hint when claude is not found on PATH', async () => {
    // Simulate "claude not on PATH" by emptying PATH for the duration of
    // the lookup. We restore it in `finally`.
    const savedPath = process.env.PATH;
    const savedPathExt = process.env.PATHEXT;
    const savedPathLower = process.env.path;
    process.env.PATH = '';
    process.env.path = '';
    if (process.platform === 'win32') {
      // Without PATHEXT `where` won't match .cmd/.exe even if it found one.
      process.env.PATHEXT = '';
    }
    try {
      await expect(resolveClaudeBinary()).rejects.toThrow(
        /Claude CLI not found.*npm i -g @anthropic-ai\/claude-code/
      );
    } finally {
      process.env.PATH = savedPath;
      if (savedPathLower !== undefined) process.env.path = savedPathLower;
      else delete process.env.path;
      if (savedPathExt !== undefined) process.env.PATHEXT = savedPathExt;
      else delete process.env.PATHEXT;
    }
  });

  it('returns a full existing path when claude is on PATH (smoke test)', async () => {
    // This test is conditional: only runs if the test machine has claude
    // installed. CI containers without it will skip — that's fine.
    let probe: string | null = null;
    try {
      probe = await resolveClaudeBinary();
    } catch {
      return; // not installed, nothing to verify
    }
    expect(probe).toBeTruthy();
    expect(existsSync(probe!)).toBe(true);
    if (process.platform === 'win32') {
      // Must be a full path, not the bare name — otherwise spawn(no-shell)
      // would fail to find the .cmd shim.
      expect(probe!.toLowerCase()).toMatch(/[a-z]:[\\/]/);
    }
  });
});
