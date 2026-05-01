#!/usr/bin/env tsx
/**
 * Schema-additive migration lint.
 *
 * Per docs/superpowers/specs/2026-05-01-v0.4-web-design.md chapter 09 §8
 * (schema-additive promise) and chapter 08 (lint workflows pattern), and
 * DAG appendix T31.
 *
 * Walks every `.sql` migration in `daemon/src/db/migrations/` (recursive)
 * AFTER the v0.3 baseline and fails if any contains a destructive change:
 *
 *   - DROP TABLE
 *   - DROP COLUMN
 *   - ALTER COLUMN ... TYPE / ALTER COLUMN ... SET DATA TYPE
 *   - ADD COLUMN ... NOT NULL  WITHOUT a DEFAULT clause
 *   - RENAME TABLE / RENAME COLUMN / ALTER TABLE ... RENAME ...
 *
 * Allowed: ADD TABLE, ADD COLUMN nullable, ADD COLUMN NOT NULL DEFAULT ...,
 * ADD INDEX, ADD CHECK, CREATE TRIGGER (additive), etc.
 *
 * Baseline detection (first match wins):
 *   1. `V03_BASELINE_MIGRATION` constant below (override),
 *   2. `daemon/src/db/migrations/.v03-baseline` file (one filename, or the
 *      sentinel `__none__` meaning "no v0.3-era migrations exist; every
 *      migration in this directory is post-baseline").
 *
 * Exit code 0 = clean, 1 = violations.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, relative, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Optional override. When non-empty, takes precedence over the
 * `.v03-baseline` file. Set this if you need to lock the baseline from the
 * script itself (e.g. for an emergency CI patch). Use `__none__` to mean
 * "no v0.3-era migrations exist".
 */
const V03_BASELINE_MIGRATION = '';

const NO_BASELINE_SENTINEL = '__none__';

interface Violation {
  file: string;
  line: number;
  rule: string;
  matched: string;
  remediation: string;
}

interface Rule {
  name: string;
  /**
   * Pattern is matched against each logical SQL statement (semicolon-split,
   * comments stripped). The `lineFor` callback maps the matched substring
   * back to a 1-based line number in the original file.
   */
  pattern: RegExp;
  remediation: string;
}

const RULES: Rule[] = [
  {
    name: 'DROP TABLE',
    pattern: /\bDROP\s+TABLE\b/i,
    remediation:
      'Schema changes must be additive in v0.4.x. Land a v0.5 schema-break announcement first; do not drop tables.',
  },
  {
    name: 'DROP COLUMN',
    pattern: /\bDROP\s+COLUMN\b/i,
    remediation:
      'Schema changes must be additive in v0.4.x. Stop writing the column instead of dropping it; reclaim the slot in v0.5.',
  },
  {
    name: 'ALTER COLUMN type change',
    // ALTER COLUMN <name> TYPE ...  /  ALTER COLUMN <name> SET DATA TYPE ...
    pattern: /\bALTER\s+COLUMN\s+\S+\s+(?:SET\s+DATA\s+)?TYPE\b/i,
    remediation:
      'Add a new column with the desired type and dual-write; do not change a column type in place.',
  },
  {
    name: 'ADD COLUMN NOT NULL without DEFAULT',
    // Bare ADD COLUMN ... NOT NULL with no DEFAULT clause anywhere in the
    // statement. The full-statement matcher below handles this.
    pattern: /\bADD\s+COLUMN\b[\s\S]*?\bNOT\s+NULL\b/i,
    remediation:
      'Either drop NOT NULL or supply a DEFAULT so existing rows have a value: ADD COLUMN x INTEGER NOT NULL DEFAULT 0.',
  },
  {
    name: 'RENAME (table or column)',
    // RENAME TABLE ... / ALTER TABLE x RENAME TO ... / RENAME COLUMN ...
    pattern: /\bRENAME\s+(?:TABLE\b|COLUMN\b|TO\b)/i,
    remediation:
      'Renames break v0.3 readers. Add a new table/column, dual-write, and remove the old name in v0.5.',
  },
];

/**
 * Strip SQL comments (-- line and /* block * /) but preserve line breaks so
 * line numbers stay aligned with the original.
 */
function stripComments(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      // line comment
      while (i < sql.length && sql[i] !== '\n') {
        out += sql[i] === '\n' ? '\n' : ' ';
        i++;
      }
    } else if (c === '/' && next === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) {
        out += sql[i] === '\n' ? '\n' : ' ';
        i++;
      }
      i += 2; // skip closing */ if present
    } else if (c === "'") {
      out += c;
      i++;
      while (i < sql.length) {
        out += sql[i];
        if (sql[i] === "'" && sql[i + 1] !== "'") {
          i++;
          break;
        }
        if (sql[i] === "'" && sql[i + 1] === "'") {
          out += sql[i + 1];
          i += 2;
          continue;
        }
        i++;
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

interface Statement {
  text: string;
  /** 1-based line number where this statement starts in the original file. */
  startLine: number;
}

function splitStatements(sql: string): Statement[] {
  const cleaned = stripComments(sql);
  const out: Statement[] = [];
  let buf = '';
  let startLine = 1;
  let line = 1;
  let pendingNewStmt = true;
  for (let i = 0; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (pendingNewStmt) {
      if (/\S/.test(c)) {
        startLine = line;
        pendingNewStmt = false;
      } else {
        // Drop leading whitespace so line offsets within `buf` align with
        // `startLine`.
        if (c === '\n') line++;
        continue;
      }
    }
    if (c === ';') {
      if (buf.trim().length > 0) {
        out.push({ text: buf, startLine });
      }
      buf = '';
      pendingNewStmt = true;
    } else {
      buf += c;
    }
    if (c === '\n') line++;
  }
  if (buf.trim().length > 0) {
    out.push({ text: buf, startLine });
  }
  return out;
}

function lineOffsetWithin(text: string, matchIndex: number): number {
  let n = 0;
  for (let i = 0; i < matchIndex && i < text.length; i++) {
    if (text[i] === '\n') n++;
  }
  return n;
}

function checkStatement(stmt: Statement, rule: Rule): Violation | null {
  const m = rule.pattern.exec(stmt.text);
  if (!m) return null;

  if (rule.name === 'ADD COLUMN NOT NULL without DEFAULT') {
    // Re-check the WHOLE statement: only fail when there is no DEFAULT clause.
    if (/\bDEFAULT\b/i.test(stmt.text)) return null;
  }

  const line = stmt.startLine + lineOffsetWithin(stmt.text, m.index);
  // Trim matched substring for readable output.
  const matched = m[0].replace(/\s+/g, ' ').trim();
  return {
    file: '',
    line,
    rule: rule.name,
    matched,
    remediation: rule.remediation,
  };
}

export function lintSqlText(sql: string): Omit<Violation, 'file'>[] {
  const stmts = splitStatements(sql);
  const out: Omit<Violation, 'file'>[] = [];
  for (const stmt of stmts) {
    for (const rule of RULES) {
      const v = checkStatement(stmt, rule);
      if (v) {
        const { file: _ignored, ...rest } = v;
        void _ignored;
        out.push(rest);
      }
    }
  }
  return out;
}

function listSqlFiles(root: string): string[] {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  const stack: string[] = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(p);
      } else if (e.isFile() && /\.sql$/i.test(e.name)) {
        out.push(p);
      }
    }
  }
  return out.sort();
}

function readBaseline(
  migrationsDir: string,
  override: string,
): { baseline: string; source: string } {
  if (override.trim().length > 0) {
    return { baseline: override.trim(), source: 'V03_BASELINE_MIGRATION' };
  }
  const baselineFile = join(migrationsDir, '.v03-baseline');
  if (!existsSync(baselineFile)) {
    throw new Error(
      `lint-schema-additive: cannot find baseline. Expected ` +
        `${baselineFile} (or set V03_BASELINE_MIGRATION in scripts/lint-schema-additive.ts).`,
    );
  }
  const text = readFileSync(baselineFile, 'utf8');
  // First non-empty, non-comment line is the baseline.
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    return { baseline: line, source: relative(process.cwd(), baselineFile) };
  }
  throw new Error(
    `lint-schema-additive: ${baselineFile} contains no baseline filename ` +
      `(use the sentinel "__none__" if there are no v0.3-era migrations).`,
  );
}

export interface LintOptions {
  cwd: string;
  /** Absolute path to migrations dir. */
  migrationsDir: string;
  /** Override baseline; if empty, falls back to .v03-baseline file. */
  baselineOverride?: string;
}

export interface LintResult {
  baseline: string;
  baselineSource: string;
  scanned: number;
  skipped: number;
  violations: Violation[];
}

export function lintSchemaAdditive(opts: LintOptions): LintResult {
  const { baseline, source } = readBaseline(
    opts.migrationsDir,
    opts.baselineOverride ?? '',
  );

  const allFiles = listSqlFiles(opts.migrationsDir);
  const violations: Violation[] = [];
  let scanned = 0;
  let skipped = 0;

  for (const abs of allFiles) {
    const rel = relative(opts.migrationsDir, abs).split(sep).join('/');
    // Filename order used for "since baseline".
    if (baseline !== NO_BASELINE_SENTINEL && rel <= baseline) {
      skipped++;
      continue;
    }
    scanned++;
    const sql = readFileSync(abs, 'utf8');
    const fileViolations = lintSqlText(sql);
    for (const v of fileViolations) {
      violations.push({ ...v, file: abs });
    }
  }

  return {
    baseline,
    baselineSource: source,
    scanned,
    skipped,
    violations,
  };
}

function formatViolation(v: Violation, cwd: string): string {
  const rel = relative(cwd, v.file).split(sep).join('/');
  return (
    `  ${rel}:${v.line}  [${v.rule}]  ${v.matched}\n` +
    `      hint: ${v.remediation}`
  );
}

function main(): void {
  const cwd = process.cwd();
  const migrationsDir = resolve(cwd, 'daemon/src/db/migrations');
  let result: LintResult;
  try {
    result = lintSchemaAdditive({
      cwd,
      migrationsDir,
      baselineOverride: V03_BASELINE_MIGRATION,
    });
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(1);
    return;
  }

  if (result.violations.length === 0) {
    process.stdout.write(
      `lint-schema-additive: baseline=${result.baseline} ` +
        `(via ${result.baselineSource}); ` +
        `scanned ${result.scanned} migration(s) since baseline ` +
        `(skipped ${result.skipped}); no violations.\n`,
    );
    process.exit(0);
  }

  process.stdout.write(
    `lint-schema-additive: baseline=${result.baseline} ` +
      `(via ${result.baselineSource}); ` +
      `scanned ${result.scanned} migration(s) since baseline ` +
      `(skipped ${result.skipped}); ${result.violations.length} violation(s):\n`,
  );
  for (const v of result.violations) {
    process.stdout.write(formatViolation(v, cwd) + '\n');
  }
  process.exit(1);
}

const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` ||
  fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? '');
if (invokedDirectly) {
  main();
}
