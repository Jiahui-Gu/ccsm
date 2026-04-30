// Task #894 — no-active-session empty pane.
//
// Contract: on a fresh app boot (no persisted sessions) the renderer must
// NOT auto-create a session and must NOT show any central CTA / Tutorial
// (those entries were removed in #894 — sidebar `+` button is the only
// entry point now). The right pane renders an empty `data-testid=
// "no-active-session-empty"` placeholder.
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
  resetStore({
    sessions: [],
    groups: [{ id: 'g-default', name: 'Sessions', collapsed: false, kind: 'normal' }],
    activeId: '',
    focusedGroupId: null,
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

describe('no-active-session empty pane (#894)', () => {
  it('renders no sessions, no central CTA, and the empty placeholder on fresh boot', () => {
    expect(useStore.getState().sessions).toHaveLength(0);
    render(<App />);
    // The empty placeholder anchor proves we hit the no-active-session
    // branch and nothing was silently created.
    expect(screen.getByTestId('no-active-session-empty')).toBeInTheDocument();
    // No central CTA buttons (removed in #894).
    expect(screen.queryByRole('button', { name: /^New session$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Import a CLI session$/ })).not.toBeInTheDocument();
    // Old first-run anchor must be gone.
    expect(screen.queryByTestId('first-run-empty')).not.toBeInTheDocument();
    // Critical: render() must not have created a session as a side effect.
    expect(useStore.getState().sessions).toHaveLength(0);
    expect(useStore.getState().activeId).toBe('');
  });
});
