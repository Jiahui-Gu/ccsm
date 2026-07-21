// Static discoverability contract for the Task 6 mobile-remote harnesses
// (composer/terminal-sync plan). `scripts/run-all-e2e.mjs` discovers every
// `scripts/harness-*.mjs` file purely by filename glob — this test proves
// the new harnesses actually exist where that glob (and this test's own
// reimplementation of it) expects them, so a rename/typo/misplaced file
// fails fast in `npm test` instead of silently dropping out of
// `npm run probe:e2e` and `run-all-e2e.mjs`'s summary.

import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const SCRIPTS_DIR = path.resolve(process.cwd(), 'scripts');

// Mirrors scripts/run-all-e2e.mjs's own discovery filter exactly.
function discoveredHarnessFiles(): string[] {
  return readdirSync(SCRIPTS_DIR)
    .filter((file) => file.startsWith('harness-') && file.endsWith('.mjs'))
    .sort();
}

describe('mobile-remote harness discoverability (Task 6)', () => {
  it('run-all-e2e.mjs\'s harness-*.mjs glob discovers all three mobile-remote harnesses', () => {
    const discovered = discoveredHarnessFiles();
    expect(discovered).toContain('harness-e2e-mobile-remote-relay.mjs');
    expect(discovered).toContain('harness-e2e-mobile-terminal-sync.mjs');
    expect(discovered).toContain('harness-e2e-mobile-remote-visual.mjs');
  });

  it('the deterministic buffer-parity fixture module exists where the harnesses import it from', () => {
    expect(existsSync(path.join(SCRIPTS_DIR, 'fixtures', 'mobile-remote-pty-fixture.mjs'))).toBe(true);
  });

  it('the shared Wrangler/simulated-desktop helper module exists where the harnesses import it from', () => {
    expect(existsSync(path.join(SCRIPTS_DIR, 'probe-helpers', 'mobileRemoteHarness.mjs'))).toBe(true);
  });

  it('the test-only bridge type declaration exists for src/mobile to reference', () => {
    expect(existsSync(path.resolve(process.cwd(), 'src', 'mobile', 'testBridge.d.ts'))).toBe(true);
  });
});
