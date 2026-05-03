// T8.2 ESLint backstop spec — Task #87, paired with tools/lint-no-ipc.sh
// (PR #853 from Task #88) and chapter 12 §4.1.
//
// What this asserts:
//   1. Each "violation-*.ts" fixture under ./fixtures/ trips the expected
//      rule (no-restricted-imports OR no-restricted-syntax).
//   2. The negative-control fixture stays lint-clean — i.e. the AST rule
//      is narrow enough not to flag legitimate `app` / `BrowserWindow`
//      named imports.
//
// Why programmatic ESLint instead of spawning the CLI:
//   - Faster (no subprocess + no config-resolution walk per file).
//   - Lets us assert exact ruleId / message-includes per fixture, so a
//     future config refactor that silently drops a selector fails loudly
//     here instead of silently letting IPC creep back in.
//
// Forever-stable surface: this spec locks in the coverage matrix from
// packages/electron/eslint.config.js. If the matrix changes, both the
// config comment and this spec must change together (reviewers: cross-
// check).

import { describe, it, expect, beforeAll } from 'vitest';
import { ESLint } from 'eslint';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, 'fixtures');
// Resolve the per-package config explicitly so we exercise the config under
// test rather than whatever ESLint's cwd-walk would discover.
const CONFIG_PATH = path.resolve(__dirname, '..', '..', 'eslint.config.js');

let eslint: ESLint;

beforeAll(() => {
  eslint = new ESLint({
    overrideConfigFile: CONFIG_PATH,
    // We are intentionally linting files that the package config's
    // `ignores` block excludes; bypass that so the spec actually runs.
    ignore: false,
  });
});

interface Expectation {
  fixture: string;
  ruleId: string;
  messageIncludes: string;
}

const VIOLATIONS: Expectation[] = [
  {
    fixture: 'violation-named-import.ts',
    ruleId: 'no-restricted-imports',
    messageIncludes: 'ipcMain',
  },
  {
    fixture: 'violation-renamed-import.ts',
    ruleId: 'no-restricted-imports',
    messageIncludes: 'ipcRenderer',
  },
  {
    fixture: 'violation-namespace-import.ts',
    ruleId: 'no-restricted-syntax',
    messageIncludes: "import * as X from 'electron'",
  },
  {
    fixture: 'violation-default-member.ts',
    ruleId: 'no-restricted-syntax',
    messageIncludes: 'member access',
  },
  {
    fixture: 'violation-require.ts',
    // The require() fixture trips both the require-call selector AND
    // the member-access selector (because the destructure pulls the
    // banned name into scope). We just assert no-restricted-syntax
    // fires; the message-includes pins it to the require selector.
    ruleId: 'no-restricted-syntax',
    messageIncludes: "require('electron')",
  },
];

describe('ESLint backstop — IPC/contextBridge ban (T8.2, ch12 §4.1)', () => {
  for (const { fixture, ruleId, messageIncludes } of VIOLATIONS) {
    it(`flags ${fixture} with ${ruleId}`, async () => {
      const file = path.join(FIXTURE_DIR, fixture);
      const [result] = await eslint.lintFiles([file]);
      expect(result, `no ESLint result for ${fixture}`).toBeDefined();
      const matching = result.messages.filter(
        (m) => m.ruleId === ruleId && (m.message ?? '').includes(messageIncludes),
      );
      expect(
        matching.length,
        `expected ${ruleId} containing "${messageIncludes}" in ${fixture}; got messages: ${JSON.stringify(result.messages, null, 2)}`,
      ).toBeGreaterThan(0);
      // All findings must be hard errors (severity 2), not warnings — a
      // warning would let CI green and IPC code would slip in.
      for (const m of matching) {
        expect(m.severity, `${ruleId} on ${fixture} must be error severity`).toBe(2);
      }
    });
  }

  it('does not false-positive on allowed electron named imports (app, BrowserWindow)', async () => {
    const file = path.join(FIXTURE_DIR, 'clean-allowed-import.ts');
    const [result] = await eslint.lintFiles([file]);
    // Filter out unrelated noise (unused vars etc) — we only care that the
    // two backstop rules stay silent on legitimate usage.
    const backstopHits = result.messages.filter(
      (m) =>
        m.ruleId === 'no-restricted-imports' || m.ruleId === 'no-restricted-syntax',
    );
    expect(
      backstopHits,
      `backstop rules false-positived on clean fixture: ${JSON.stringify(backstopHits, null, 2)}`,
    ).toEqual([]);
  });
});
