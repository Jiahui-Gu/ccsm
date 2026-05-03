// packages/daemon/build/__tests__/sea-config.spec.ts
//
// Lightweight JSON-shape gate for the Node 22 sea pipeline. Spec ch10 §1
// pins specific sea-config flags; if these drift the daemon either fails
// to build (good — caught at build time) or builds a binary with the wrong
// runtime characteristics (bad — useCodeCache / useSnapshot mistakes can
// silently regress startup latency or break native-module init). This test
// catches the latter at unit-test time.
//
// Per task brief: a full sea integration test is intentionally NOT run in
// CI because the build is heavy (esbuild + node copy + postject). This
// spec is the cheapest forever-stable contract we can keep green.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_PATH = path.resolve(__dirname, '../sea-config.json');

interface SeaConfig {
  main: string;
  output: string;
  disableExperimentalSEAWarning: boolean;
  useCodeCache: boolean;
  useSnapshot: boolean;
}

function loadConfig(): SeaConfig {
  const raw = readFileSync(CONFIG_PATH, 'utf8');
  return JSON.parse(raw) as SeaConfig;
}

describe('packages/daemon/build/sea-config.json (spec ch10 §1)', () => {
  it('parses as JSON', () => {
    expect(() => loadConfig()).not.toThrow();
  });

  it('main points to the esbuild bundle output (CJS, CWD-relative to package dir)', () => {
    const cfg = loadConfig();
    expect(cfg.main).toBe('dist/bundle.cjs');
  });

  it('output is the sea-prep.blob staging path (CWD-relative to package dir)', () => {
    const cfg = loadConfig();
    expect(cfg.output).toBe('dist/sea-prep.blob');
  });

  it('useCodeCache is true (spec: faster startup)', () => {
    expect(loadConfig().useCodeCache).toBe(true);
  });

  it('useSnapshot is false (spec: snapshot complicates native-module init in v0.3)', () => {
    expect(loadConfig().useSnapshot).toBe(false);
  });

  it('disableExperimentalSEAWarning is true (no stderr noise in service logs)', () => {
    expect(loadConfig().disableExperimentalSEAWarning).toBe(true);
  });

  it('contains no unexpected top-level keys (forever-stable shape)', () => {
    const cfg = loadConfig() as unknown as Record<string, unknown>;
    const allowed = new Set([
      'main',
      'output',
      'disableExperimentalSEAWarning',
      'useCodeCache',
      'useSnapshot',
    ]);
    for (const key of Object.keys(cfg)) {
      expect(allowed.has(key), `unexpected sea-config key: ${key}`).toBe(true);
    }
  });
});
