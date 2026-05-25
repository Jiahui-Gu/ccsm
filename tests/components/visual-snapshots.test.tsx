// Visual-regression snapshot net for top-level "chrome" components that
// have stable, deterministic DOM with minimal state. The intent is documented
// in DEBT.md (test-coverage debt 2026-05-25): convert "needs human visual
// verification" into "vitest snapshot diff" so refactors and dep bumps
// (Electron 41→42, React 18→19, etc.) surface UI regressions automatically.
//
// Scope (deliberately narrow):
//   - Pure-DOM stable components only — no xterm canvas, no framer-motion
//     content (presence wrappers are fine; they degrade to plain DOM in
//     jsdom), no responsive layout that depends on real measurements.
//   - jsdom only — no Playwright / screenshot diff. Cross-platform CI text
//     rendering varies (Linux xvfb font hinting in particular); HTML diff
//     stays clean across Win/Mac/Linux.
//   - These snapshots are intentionally NOT a substitute for harness-ui or
//     for real-user dogfood. They catch DOM-shape regressions only. CSS-only
//     visual changes (color, spacing) still need real-machine eyes.
//
// Update protocol: when a snapshot fails after an intentional UI change, run
// `npx vitest -u tests/components/visual-snapshots.test.tsx` to refresh
// and review the .snap diff in the PR alongside the JSX change.
import React from 'react';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { AppSkeleton } from '../../src/components/AppSkeleton';
import { InstallerCorruptBanner } from '../../src/components/InstallerCorruptBanner';
import { ClaudeMissingGuide } from '../../src/components/ClaudeMissingGuide';
import { AppShell } from '../../src/components/AppShell';
import { resetStore } from '../util/resetStore';

afterEach(() => cleanup());
beforeEach(() => resetStore());

describe('visual snapshots — chrome components', () => {
  // AppSkeleton is the pre-hydrate placeholder. Zero props, zero store reads
  // that mutate output (it derives platform from `window.ccsm`, which is the
  // jsdom-injected stub from tests/setup.ts). Stable across runs.
  it('AppSkeleton — pre-hydrate placeholder DOM is stable', () => {
    const { container } = render(<AppSkeleton />);
    expect(container.innerHTML).toMatchSnapshot();
  });

  // InstallerCorruptBanner reads `installerCorrupt` from the store. We test
  // both the visible and hidden states so a refactor that swaps the
  // conditional rendering (e.g. CSS hide vs unmount) is loud.
  it('InstallerCorruptBanner — hidden when installerCorrupt=false', () => {
    resetStore({ installerCorrupt: false });
    const { container } = render(<InstallerCorruptBanner />);
    expect(container.innerHTML).toMatchSnapshot();
  });

  it('InstallerCorruptBanner — shown when installerCorrupt=true', () => {
    resetStore({ installerCorrupt: true });
    const { container } = render(<InstallerCorruptBanner />);
    expect(container.innerHTML).toMatchSnapshot();
  });

  // ClaudeMissingGuide is the "Claude binary not found" recovery surface.
  // One callback prop; we pass a no-op since snapshot doesn't exercise it.
  it('ClaudeMissingGuide — recovery surface DOM is stable', () => {
    const { container } = render(<ClaudeMissingGuide onResolved={() => {}} />);
    expect(container.innerHTML).toMatchSnapshot();
  });

  // AppShell is the structural sidebar+main layout slot used by AppSkeleton
  // and the real App. Snapshot the empty-slot shape so layout drift
  // (e.g. flex direction flip, padding change) is caught even when the
  // children are unstable.
  it('AppShell — empty slot structure is stable', () => {
    const { container } = render(
      <AppShell
        sidebar={<aside data-testid="snap-sidebar" />}
        main={<main data-testid="snap-main" />}
      />,
    );
    expect(container.innerHTML).toMatchSnapshot();
  });
});
