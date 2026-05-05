// Task #601 / spec §5.3.2 PR-2 acceptance UT (audit Variant A,
// docs/audit/2026-05-06-ccsmstore-eval-order.md §4).
//
// Regression armor against spec §2.2 root cause B (duplicate-store
// regression: a sibling re-export creates two `useStore` instances;
// harness writes to one, renderer reads the other → seedStore appears
// to succeed but the rendered tree subscribes to the wrong store).
//
// Audit verified the count is 1 today (`src/stores/store.ts:18`). This
// test pins that to CI: any future refactor that introduces a second
// `create<...>(...)` call under `src/stores/**` must explicitly delete
// or relax this assertion (and write up why a second store instance is
// safe in the PR body).
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      out.push(...listTsFiles(full));
    } else if (st.isFile()) {
      if (!entry.endsWith('.ts')) continue;
      if (entry.endsWith('.test.ts') || entry.endsWith('.d.ts')) continue;
      out.push(full);
    }
  }
  return out;
}

describe('store: single zustand instance under src/stores', () => {
  it('contains exactly one `create<...>(...)` call', () => {
    const files = listTsFiles(resolve(repoRoot, 'src/stores'));
    expect(files.length).toBeGreaterThan(0);

    // Match `create<RootStore>(` or `create<…>(` etc. — zustand v4's
    // typed factory call. Whitespace tolerant. We deliberately do NOT
    // match the bare `create(` form (no generic) because the codebase
    // standardised on the typed form; if someone introduces an untyped
    // sibling it should still be caught — extend the pattern then.
    const re = /\bcreate\s*<[^>]*>\s*\(/g;

    const hits: { file: string; count: number }[] = [];
    let total = 0;
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const matches = src.match(re);
      const count = matches ? matches.length : 0;
      if (count > 0) hits.push({ file: f, count });
      total += count;
    }

    expect(
      total,
      `expected exactly one zustand create<...>() call across src/stores/**, got ${total}: ${JSON.stringify(hits, null, 2)}`
    ).toBe(1);
  });
});
