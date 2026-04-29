// Task #329 — first-run empty state.
//
// Contract: on a fresh app boot (no persisted sessions) the renderer must
// NOT auto-create a session. Instead it shows a sentence-case CTA palette
// (new session + import) anchored on data-testid="first-run-empty". The
// welcome heading, "Create a new group" link, and tip line were removed
// in #353 — they were visual noise that didn't unlock any action. This
// test guards against the regression where some startup hook silently
// calls createSession() and bypasses the empty state.
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import App from '../src/App';
import { useStore } from '../src/stores/store';
import { resetStore } from './util/resetStore';

function stubCCSM() {
  const api = {
    pathsExist: vi.fn().mockResolvedValue({}),
    recentCwds: vi.fn().mockResolvedValue([]),
    defaultModel: vi.fn().mockResolvedValue(null),
    onUpdateDownloaded: vi.fn().mockReturnValue(() => {}),
    cliCheck: vi.fn().mockResolvedValue({ state: 'found', binaryPath: '/usr/bin/claude' }),
    settingsLoad: vi.fn().mockResolvedValue({}),
    modelsList: vi.fn().mockResolvedValue([]),
    window: {
      onBeforeHide: vi.fn().mockReturnValue(() => {}),
      onAfterShow: vi.fn().mockReturnValue(() => {}),
      isMaximized: vi.fn().mockResolvedValue(false),
      onMaximizedChanged: vi.fn().mockReturnValue(() => {}),
      minimize: vi.fn(),
      maximize: vi.fn(),
      unmaximize: vi.fn(),
      close: vi.fn()
    },
    i18n: {
      getSystemLocale: vi.fn().mockResolvedValue('en'),
      setLanguage: vi.fn()
    }
  };
  (globalThis as unknown as { window: Window & { ccsm?: unknown } }).window.ccsm = api;
  return api;
}

// jsdom doesn't ship matchMedia; several components (CommandPalette,
// AppShell theme apply) call it during mount. A no-op shim is enough.
function stubMatchMedia() {
  if (typeof window === 'undefined' || window.matchMedia) return;
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false
    })
  });
}

beforeEach(() => {
  cleanup();
  // Fresh boot: no sessions, no active id, but tutorialSeen=true so the
  // empty-state CTA renders (Tutorial path is exercised separately).
  resetStore({
    sessions: [],
    groups: [{ id: 'g-default', name: 'Sessions', collapsed: false, kind: 'normal' }],
    activeId: '',
    focusedGroupId: null,
    tutorialSeen: true,
    // perf/startup-render-gate: App now renders a skeleton until
    // `hydrated` flips true. The empty-state CTA branch (what this test
    // pins) is gated behind hydrated=true so users with persisted
    // sessions still loading don't flash the first-run landing.
    hydrated: true,
    messagesBySession: {},
    startedSessions: {},
    runningSessions: {},
    messageQueues: {},
    focusInputNonce: 0
  });
  stubCCSM();
  stubMatchMedia();
});

describe('first-run empty state', () => {
  it('renders no sessions and the first-run CTA palette on fresh boot', () => {
    expect(useStore.getState().sessions).toHaveLength(0);
    render(<App />);
    // The data-testid anchor proves we hit the empty-state branch (not the
    // ChatStream branch) AND that no session was silently created during
    // render.
    expect(screen.getByTestId('first-run-empty')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^New session$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Import a CLI session$/ })).toBeInTheDocument();
    // Removed in #353 — must not be present.
    expect(screen.queryByText(/Welcome to ccsm\./i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Create a new group$/ })).not.toBeInTheDocument();
    expect(
      screen.queryByText(/groups organize sessions by task, not by repo/i)
    ).not.toBeInTheDocument();
    // Critical: render() must not have created a session as a side effect.
    expect(useStore.getState().sessions).toHaveLength(0);
    expect(useStore.getState().activeId).toBe('');
  });

  // Audit gap (PR #568, no-sessions a3): the original e2e probe asserted the
  // two empty-state buttons share width/height (+/-0.5px). jsdom can't measure
  // real layout, so we instead pin the className tokens that drive sizing —
  // both buttons use `size="md"` (h-8 via Button variants) AND both carry the
  // `w-44 justify-center` shape class. If either button drifts off these
  // tokens, the visual width/height parity in real Chromium will break.
  it('empty-state CTAs share size/shape className tokens (jsdom layout proxy)', () => {
    render(<App />);
    const newBtn = screen.getByRole('button', { name: /^New session$/ });
    const importBtn = screen.getByRole('button', { name: /^Import a CLI session$/ });
    // Same width + center justification — visual width parity in real layout.
    expect(newBtn.className).toMatch(/\bw-44\b/);
    expect(newBtn.className).toMatch(/\bjustify-center\b/);
    expect(importBtn.className).toMatch(/\bw-44\b/);
    expect(importBtn.className).toMatch(/\bjustify-center\b/);
    // Both buttons must share their parent's flex row (data-testid anchor) so
    // their height is driven by the same `size="md"` Button preset.
    const parent = screen.getByTestId('first-run-empty');
    expect(parent).toContainElement(newBtn);
    expect(parent).toContainElement(importBtn);
  });
});
