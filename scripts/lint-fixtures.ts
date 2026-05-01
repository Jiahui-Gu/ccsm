#!/usr/bin/env tsx
/**
 * Test fixture lint — anonymization + size cap.
 *
 * Per docs/superpowers/specs/2026-05-01-v0.4-web-design.md chapter 08 §8.
 *
 * Walks test fixture directories and scans each file for:
 *   - Size cap: > 1 MiB → FAIL
 *   - Real OS user paths (Windows / macOS / Linux)
 *   - Real session UUIDs (any UUID v4 not in allow-list)
 *   - Real Cloudflare account IDs (32 hex chars, flagged)
 *   - JWT token fragments
 *   - GitHub tokens
 *   - AWS access keys
 *
 * Exit code 0 = clean, 1 = violations.
 *
 * Files under `**\/__fixtures__/anonymized/**` are exempt (intentionally
 * anonymized examples used by tests).
 *
 * Allow-list of test UUIDs lives in scripts/__test-uuids.txt (one per line,
 * `#` comments allowed). Add UUIDs there when introducing fictional fixtures.
 */
import { readFileSync, statSync, existsSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { globSync } from 'glob';

const ONE_MIB = 1024 * 1024;

const FIXTURE_GLOBS = [
  '**/__fixtures__/**',
  '**/*.fixture.json',
  '**/test/fixtures/**',
  '**/__tests__/**/fixtures/**',
];

// Glob patterns to ignore wholesale.
const IGNORE = [
  '**/node_modules/**',
  '**/dist/**',
  '**/dist-*/**',
  '**/out/**',
  '**/.git/**',
  '**/coverage/**',
  // Allow-listed anonymized examples — must be matched literally.
  '**/__fixtures__/anonymized/**',
];

interface Violation {
  file: string;
  rule: string;
  detail: string;
}

interface Rule {
  name: string;
  // If `failOnMatch` is true, presence is always a hard fail.
  // If false, the match is reported as a violation only when not on allow-list.
  failOnMatch: boolean;
  pattern: RegExp;
  // Optional per-match filter; return true to KEEP the match as a violation.
  keep?: (match: string) => boolean;
}

function loadUuidAllowList(scriptDir: string): Set<string> {
  const p = resolve(scriptDir, '__test-uuids.txt');
  if (!existsSync(p)) return new Set();
  const lines = readFileSync(p, 'utf8').split(/\r?\n/);
  const out = new Set<string>();
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    out.add(line.toLowerCase());
  }
  return out;
}

function buildRules(uuidAllow: Set<string>): Rule[] {
  return [
    {
      name: 'windows-user-path',
      failOnMatch: true,
      // C:\Users\<name>  (case-insensitive). Tolerate JSON-escaped form
      // (`C:\\Users\\name`) so paths embedded in JSON fixtures are caught.
      pattern: /[a-zA-Z]:\\{1,2}Users\\{1,2}[A-Za-z][A-Za-z0-9._-]*/gi,
    },
    {
      name: 'macos-user-path',
      failOnMatch: true,
      pattern: /\/Users\/[A-Za-z][A-Za-z0-9._-]*/g,
    },
    {
      name: 'linux-user-path',
      failOnMatch: true,
      pattern: /\/home\/[A-Za-z][A-Za-z0-9._-]*/g,
    },
    {
      name: 'session-uuid',
      failOnMatch: true,
      pattern:
        /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      keep: (m) => !uuidAllow.has(m.toLowerCase()),
    },
    {
      name: 'cf-account-id',
      failOnMatch: true,
      // Must NOT be embedded in a longer hex run (e.g. file hashes).
      // Use lookarounds for word-ish boundaries.
      pattern: /(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/gi,
    },
    {
      name: 'jwt-token',
      failOnMatch: true,
      pattern: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    },
    {
      name: 'github-token',
      failOnMatch: true,
      pattern: /gh[pousr]_[A-Za-z0-9]{36,}/g,
    },
    {
      name: 'aws-access-key',
      failOnMatch: true,
      pattern: /AKIA[0-9A-Z]{16}/g,
    },
  ];
}

function scanFile(absPath: string, rules: Rule[]): Violation[] {
  const violations: Violation[] = [];
  let st;
  try {
    st = statSync(absPath);
  } catch {
    return violations;
  }
  if (!st.isFile()) return violations;

  if (st.size > ONE_MIB) {
    violations.push({
      file: absPath,
      rule: 'size-cap',
      detail: `${st.size} bytes (> ${ONE_MIB} bytes / 1 MiB)`,
    });
    // Don't scan content of huge files — already failing.
    return violations;
  }

  let buf: Buffer;
  try {
    buf = readFileSync(absPath);
  } catch {
    return violations;
  }
  // Skip apparent binaries (NUL bytes in first 8 KiB).
  const sniff = buf.subarray(0, 8192);
  for (const b of sniff) {
    if (b === 0) return violations;
  }
  const text = buf.toString('utf8');

  for (const rule of rules) {
    const matches = text.matchAll(rule.pattern);
    const seen = new Set<string>();
    for (const m of matches) {
      const value = m[0];
      if (rule.keep && !rule.keep(value)) continue;
      if (seen.has(value)) continue;
      seen.add(value);
      violations.push({
        file: absPath,
        rule: rule.name,
        detail: value,
      });
    }
  }
  return violations;
}

export interface LintOptions {
  cwd: string;
  scriptDir: string;
  // Optional override of fixture globs (used by tests).
  fixtureGlobs?: string[];
  // Optional override of ignore globs (used by tests to drop the
  // anonymized allow-list when verifying allow-list behavior).
  ignore?: string[];
}

export interface LintResult {
  scanned: number;
  violations: Violation[];
}

export function lintFixtures(opts: LintOptions): LintResult {
  const uuidAllow = loadUuidAllowList(opts.scriptDir);
  const rules = buildRules(uuidAllow);
  const globs = opts.fixtureGlobs ?? FIXTURE_GLOBS;
  const ignore = opts.ignore ?? IGNORE;

  const seen = new Set<string>();
  for (const pattern of globs) {
    const hits = globSync(pattern, {
      cwd: opts.cwd,
      ignore,
      nodir: true,
      absolute: true,
      dot: false,
    });
    for (const h of hits) seen.add(h);
  }

  const violations: Violation[] = [];
  for (const file of seen) {
    violations.push(...scanFile(file, rules));
  }
  return { scanned: seen.size, violations };
}

function formatViolation(v: Violation, cwd: string): string {
  const rel = relative(cwd, v.file).split(sep).join('/');
  return `  [${v.rule}] ${rel}: ${v.detail}`;
}

function main(): void {
  const cwd = process.cwd();
  // scripts/lint-fixtures.ts → scriptDir = scripts/
  const scriptDir = resolve(fileURLToPath(import.meta.url), '..');
  const result = lintFixtures({ cwd, scriptDir });

  if (result.violations.length === 0) {
    process.stdout.write(
      `lint-fixtures: scanned ${result.scanned} file(s), no violations.\n`,
    );
    process.exit(0);
  }

  process.stdout.write(
    `lint-fixtures: scanned ${result.scanned} file(s), ${result.violations.length} violation(s):\n`,
  );
  for (const v of result.violations) {
    process.stdout.write(formatViolation(v, cwd) + '\n');
  }
  process.exit(1);
}

// Only run main() when invoked as a script, not when imported by tests.
const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` ||
  fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? '');
if (invokedDirectly) {
  main();
}
