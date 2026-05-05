// Daemon-package vitest config. Co-located `*.spec.ts` files next to the
// source they cover (vs. the root `tests/**/*.test.ts` convention used by
// the legacy renderer/electron code). Daemon code is pure node — no jsdom.

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Resolve `@ccsm/snapshot-codec` directly to its source entry so daemon
// specs can import the production codec without requiring the sibling
// package to be pre-built (matches the @ccsm/proto alias pattern in
// vitest.config.coverage.ts; same root cause — npm ci on CI without a
// `workspaces` field skips the pnpm symlink).
const snapshotCodecSrcIndex = fileURLToPath(
  new URL('../snapshot-codec/src/index.ts', import.meta.url),
);

export default defineConfig({
  resolve: {
    alias: {
      '@ccsm/snapshot-codec': snapshotCodecSrcIndex,
    },
  },
  test: {
    environment: 'node',
    // `eslint-plugins/**` holds the local ESLint plugin source + its
    // RuleTester suite (e.g. T1.9 ccsm/no-listener-slot-mutation). They
    // are not under `src/` because they are tooling, not daemon runtime.
    // `build/**` holds the SEA build pipeline tooling + tests (T7.1).
    // `test/**` holds out-of-tree integration / harness / contract specs
    // that cannot be co-located with src (they instantiate cross-module
    // fixtures, read packaged migrations/fixtures, or are forever-stable
    // contract specs per design spec ch12 §3). Examples:
    //   - test/supervisor/contract.spec.ts (golden response bodies)
    //   - test/pty-host/ (T4.1 child_process.fork lifecycle)
    //   - test/db/migration-lock.spec.ts (T10.1 migration lock self-check)
    //   - test/integration/pty-soak-{1h,10m}.spec.ts (T8.4 PTY soak ship-gate)
    // Note: forward-compat placeholder specs may hard-fail until their
    // dependencies land — land the dep in the same PR that re-includes,
    // or keep the spec under `src/<sub>/__tests__/`.
    include: [
      'src/**/*.spec.ts',
      'build/**/*.spec.ts',
      'eslint-plugins/**/*.spec.ts',
      'test/**/*.spec.ts',
    ],
    // Exclude PTY soak ship-gate specs from the default daemon test run
    // (Task #491). They are scaffolds that depend on the v0.4 claude-sim
    // driver (T4.6 / T8.7) and self-skip via `describe.skipIf` today, but
    // a `describe.skipIf` skip still surfaces in the PR CI report and
    // muddies the "no skipped tests" ship rule. The specs remain
    // git-tracked and are exercised by .github/workflows/pty-soak.yml
    // (workflow_dispatch + nightly schedule); excluding them here keeps
    // them out of the per-PR `pnpm -F @ccsm/daemon test` path only.
    // Reverse-verify: deleting these two entries makes
    // `npx vitest list` re-emit pty-soak-1h.spec.ts / pty-soak-10m.spec.ts.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/test/integration/pty-soak-1h.spec.ts',
      '**/test/integration/pty-soak-10m.spec.ts',
    ],
    globals: false,
  },
});
