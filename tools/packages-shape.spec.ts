/**
 * tools/packages-shape.spec.ts
 *
 * FOREVER-STABLE per design spec ch15 §3 #10:
 *   "Reshuffling `packages/` directories; only additions allowed.
 *    Mechanism: human review with reference test as smoke check —
 *    `tools/packages-shape.spec.ts` enumerates `packages/*\/package.json`
 *    and asserts the v0.3 set (`proto`, `daemon`, `electron`) is a subset
 *    of the actual set; rename or removal trips the test."
 *
 * Locked v0.3 packages set — DO NOT REMOVE entries from this list. v0.4+
 * MAY ADD new packages (e.g. `@ccsm/web`, `@ccsm/cli`) to the actual
 * `packages/` tree; the assertion is "subset of actual", not "equals
 * actual", so additions never break this test.
 *
 * Layer 1 notes:
 *   - No new npm deps. Uses only `node:fs` + `node:path`.
 *   - `pnpm-workspace.yaml` parsed by trivial regex (one `packages: [...]`
 *     line) instead of importing a YAML library — see CLAUDE.md / dev.md
 *     §1 no-wheel-reinvention.
 *   - Test runs via `npx vitest run tools/packages-shape.spec.ts`. CLI path
 *     argument overrides root vitest config's `include`, so no extra
 *     vitest config is needed in `tools/`.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Repo root = parent of this file's directory (`tools/`).
// ESM-safe: project is "type":"module", so `__dirname` is undefined and
// flagged by ESLint no-undef. Derive it from `import.meta.url` instead.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// FROZEN v0.3 packages set. Adding entries here is a v0.3 contract change
// and requires R4 sign-off. Removing or renaming entries is forbidden.
const V03_REQUIRED_PACKAGES = ['@ccsm/daemon', '@ccsm/electron', '@ccsm/proto'] as const;

/**
 * Parse the trivial `packages:` list out of pnpm-workspace.yaml.
 *
 * Supported shapes (matches what pnpm itself accepts and what we ship):
 *   packages:
 *     - "packages/*"
 *     - 'packages/foo'
 *     - packages/bar
 *
 *   packages: ["packages/*"]   (inline flow form)
 *
 * Anything more exotic (anchors, multi-doc, comments mid-value) will fall
 * through and the test will fail loudly — which is the correct outcome,
 * because the workspace file should stay trivial.
 */
function parseWorkspaceGlobs(yamlText: string): string[] {
  const lines = yamlText.split(/\r?\n/);
  const globs: string[] = [];
  let inPackagesBlock = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, ''); // strip trailing comments
    const trimmed = line.trim();
    if (trimmed === '') continue;

    // Inline flow form: `packages: ["a", "b"]`
    const inlineMatch = /^packages:\s*\[(.+)\]\s*$/.exec(trimmed);
    if (inlineMatch) {
      for (const part of inlineMatch[1].split(',')) {
        const cleaned = part.trim().replace(/^['"]|['"]$/g, '');
        if (cleaned) globs.push(cleaned);
      }
      continue;
    }

    if (/^packages:\s*$/.test(trimmed)) {
      inPackagesBlock = true;
      continue;
    }

    if (inPackagesBlock) {
      const itemMatch = /^-\s+(.+)$/.exec(trimmed);
      if (itemMatch) {
        const cleaned = itemMatch[1].trim().replace(/^['"]|['"]$/g, '');
        if (cleaned) globs.push(cleaned);
        continue;
      }
      // A non-list-item, non-blank line ends the block.
      inPackagesBlock = false;
    }
  }

  return globs;
}

/**
 * Enumerate every `packages/<dir>/package.json` and return its `name` field.
 * We deliberately do NOT expand arbitrary globs — v0.3 ships exactly one
 * pattern (`packages/*`) and that is all we need to support. If a future
 * change adds a more complex glob, this enumerator should be extended
 * intentionally rather than silently accepting it.
 */
function enumerateActualPackageNames(): string[] {
  const packagesDir = join(REPO_ROOT, 'packages');
  const entries = readdirSync(packagesDir);
  const names: string[] = [];
  for (const entry of entries) {
    const pkgJsonPath = join(packagesDir, entry, 'package.json');
    try {
      const stat = statSync(pkgJsonPath);
      if (!stat.isFile()) continue;
    } catch {
      continue; // missing package.json — not a workspace package
    }
    const json = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { name?: unknown };
    if (typeof json.name === 'string' && json.name.length > 0) {
      names.push(json.name);
    }
  }
  return names;
}

describe('packages shape (v0.3 forever-stable)', () => {
  it('pnpm-workspace.yaml still globs packages/*', () => {
    const yamlText = readFileSync(join(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8');
    const globs = parseWorkspaceGlobs(yamlText);
    expect(
      globs,
      'pnpm-workspace.yaml MUST keep a `packages/*` glob (or a superset that contains every v0.3 package directory). See design spec ch15 §3 #10.',
    ).toContain('packages/*');
  });

  it('every v0.3 package name is present in packages/*/package.json', () => {
    const actual = enumerateActualPackageNames();
    const actualSet = new Set(actual);
    const missing = V03_REQUIRED_PACKAGES.filter((name) => !actualSet.has(name));
    expect(
      missing,
      `v0.3 packages set is FROZEN per design spec ch15 §3 #10. ` +
        `Missing from actual packages/: [${missing.join(', ')}]. ` +
        `Actual set: [${actual.join(', ')}]. ` +
        `v0.4 may ADD packages but MUST NOT remove or rename any v0.3 entry.`,
    ).toEqual([]);
  });
});
