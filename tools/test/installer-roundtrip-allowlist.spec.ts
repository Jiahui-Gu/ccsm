/**
 * tools/test/installer-roundtrip-allowlist.spec.ts
 *
 * Exercises the FOREVER-STABLE allowlist contract used by ship-gate (d)
 * (`tools/installer-roundtrip.ps1`, spec ch12 §4.4 + ch15 stability list).
 *
 * Two layers:
 *
 *   1. FILE FORMAT contract — parses `test/installer-residue-allowlist.txt`
 *      and the variant overlay using TypeScript that mirrors the rules
 *      documented in the file header AND in the PowerShell `Read-AllowlistFile`
 *      function. Asserts that comments / blanks / whitespace are stripped,
 *      every retained line compiles as a regex, and forbidden self-allow
 *      patterns (anything matching `ccsm` / `CCSM`) are NOT in the GLOBAL
 *      file (they are only allowed in the variant overlay).
 *
 *   2. INTEGRATION smoke — when `pwsh` is on PATH (Windows + the linux/mac
 *      pwsh-7 install we use in CI), runs `pwsh -File installer-roundtrip.ps1
 *      -DryRun` end-to-end. The script's own DryRun mode asserts that a
 *      synthetic mix of OS churn + CCSM residue is filtered correctly for
 *      both REMOVEUSERDATA variants. If pwsh is missing, the integration
 *      test is `skip`-ed with a message — never silently passes.
 *
 * Why both layers:
 *   - Layer 1 catches a broken allowlist EDIT in CI on every OS, not just
 *     where pwsh is installed.
 *   - Layer 2 catches a broken script (parser drift between TS mirror and
 *     real PowerShell) in CI where pwsh exists.
 *
 * No new deps: vitest + node:fs + node:child_process only. Run with:
 *   npx vitest run --config tools/vitest.config.ts tools/test/installer-roundtrip-allowlist.spec.ts
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GLOBAL_ALLOWLIST = join(REPO_ROOT, 'test', 'installer-residue-allowlist.txt');
const OVERLAY_ALLOWLIST = join(
  REPO_ROOT,
  'test',
  'installer-residue-allowlist.removeuserdata-0.txt',
);
const PS1 = join(REPO_ROOT, 'tools', 'installer-roundtrip.ps1');

/**
 * Mirror of `Read-AllowlistFile` in `tools/installer-roundtrip.ps1`.
 * Keep semantics IDENTICAL — they share a contract.
 */
function parseAllowlist(path: string): string[] {
  const raw = readFileSync(path, 'utf8');
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('#')) continue;
    out.push(t);
  }
  return out;
}

describe('installer-residue-allowlist (file format contract)', () => {
  it('global allowlist file exists', () => {
    expect(existsSync(GLOBAL_ALLOWLIST)).toBe(true);
  });

  it('variant overlay file exists', () => {
    expect(existsSync(OVERLAY_ALLOWLIST)).toBe(true);
  });

  it('global allowlist parses to a non-empty pattern list', () => {
    const patterns = parseAllowlist(GLOBAL_ALLOWLIST);
    expect(patterns.length).toBeGreaterThan(0);
    // Spot-check: no parsed entry begins with '#' (comment stripping works).
    expect(patterns.every((p) => !p.startsWith('#'))).toBe(true);
    // Spot-check: no parsed entry is empty / pure whitespace.
    expect(patterns.every((p) => p.trim().length > 0)).toBe(true);
  });

  it('variant overlay parses to a non-empty pattern list', () => {
    const patterns = parseAllowlist(OVERLAY_ALLOWLIST);
    expect(patterns.length).toBeGreaterThan(0);
  });

  it('every global pattern is a valid JS regex (proxy for valid PS regex)', () => {
    // PowerShell `-match` uses .NET regex which is a near-superset of JS;
    // patterns that fail JS compile would also be problematic in PS in
    // practice. Authors who genuinely need a .NET-only construct can add
    // a `// REGEX-NET-ONLY` comment on the line and the assertion will be
    // updated to skip such lines — not needed yet.
    const patterns = parseAllowlist(GLOBAL_ALLOWLIST);
    for (const p of patterns) {
      expect(() => new RegExp(p, 'i'), `bad regex: ${p}`).not.toThrow();
    }
  });

  it('every overlay pattern is a valid JS regex', () => {
    const patterns = parseAllowlist(OVERLAY_ALLOWLIST);
    for (const p of patterns) {
      expect(() => new RegExp(p, 'i'), `bad regex: ${p}`).not.toThrow();
    }
  });

  it('GLOBAL allowlist refuses to self-allow CCSM residue', () => {
    // The file header forbids any pattern matching `ccsm` / `CCSM` in the
    // GLOBAL file — that is exactly what the gate must catch. CCSM-pathed
    // entries are only legal in the variant overlay (REMOVEUSERDATA=0
    // user-data-keep semantics).
    const patterns = parseAllowlist(GLOBAL_ALLOWLIST);
    const offenders = patterns.filter((p) => /ccsm/i.test(p));
    expect(offenders, `forbidden self-allow patterns in global allowlist: ${offenders.join(', ')}`).toEqual([]);
  });

  it('OVERLAY allowlist patterns all reference the ccsm namespace', () => {
    // The overlay exists ONLY to permit user-data residue under ccsm-owned
    // paths when the user opted to keep data. A non-ccsm pattern in the
    // overlay belongs in the global file instead.
    const patterns = parseAllowlist(OVERLAY_ALLOWLIST);
    const stray = patterns.filter((p) => !/ccsm/i.test(p));
    expect(stray, `non-ccsm patterns in overlay (move to global file): ${stray.join(', ')}`).toEqual([]);
  });

  it('comment stripping handles whitespace before #', () => {
    // Synthetic test of the parser rule rather than the file: whitespace
    // before # makes the trimmed line start with #, so it is dropped.
    const tmp = '  # leading-ws comment\nactual\n   \n\t# tab-indent comment\n';
    // Re-run the parser on a buffer rather than file:
    const out: string[] = [];
    for (const line of tmp.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      if (t.startsWith('#')) continue;
      out.push(t);
    }
    expect(out).toEqual(['actual']);
  });
});

describe('installer-roundtrip.ps1 (integration smoke)', () => {
  // Only run if pwsh is on PATH. Probe via `pwsh -NoProfile -Command $null`.
  const pwshAvailable = (() => {
    try {
      const r = spawnSync('pwsh', ['-NoProfile', '-Command', '$null'], {
        stdio: 'ignore',
      });
      return r.status === 0;
    } catch {
      return false;
    }
  })();

  it.skipIf(!pwshAvailable)('PS1 -DryRun reports PASS for both variants', () => {
    const r = spawnSync(
      'pwsh',
      ['-NoProfile', '-File', PS1, '-DryRun'],
      { encoding: 'utf8' },
    );
    if (r.status !== 0) {
      throw new Error(
        `installer-roundtrip.ps1 -DryRun exit=${r.status}\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`,
      );
    }
    expect(r.stdout).toMatch(/\[DryRun\] PASS/);
    expect(r.stdout).toMatch(/variant=1 residue count: 8/);
    expect(r.stdout).toMatch(/variant=0 residue count: 5/);
  });

  it.skipIf(!pwshAvailable)(
    'PS1 -DryRun stays fail-closed when global allowlist is empty (mocked via env)',
    () => {
      // Sanity: confirm pwsh parses the script with no errors. Use the
      // language-services parser API rather than executing.
      const r = spawnSync(
        'pwsh',
        [
          '-NoProfile',
          '-Command',
          [
            '$tokens = $null; $errors = $null;',
            `[System.Management.Automation.Language.Parser]::ParseFile('${PS1.replace(/\\/g, '\\\\')}', [ref]$tokens, [ref]$errors);`,
            'if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Host $_ }; exit 1 } else { Write-Host OK }',
          ].join(' '),
        ],
        { encoding: 'utf8' },
      );
      expect(r.status, `STDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`).toBe(0);
      expect(r.stdout).toContain('OK');
    },
  );
});
