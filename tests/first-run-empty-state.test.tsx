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

const initial = useStore.getState();

function stubCCSM() {
  const api = {
    pickDirectory: vi.fn().mockResolvedValue(null),
    pathsExist: vi.fn().mockResolvedValue({}),
    recentCwds: vi.fn().mockResolvedValue([]),
    defaultModel: vi.fn().mockResolvedValue(null),
    onUpdateDownloaded: vi.fn().mockReturnValue(() => {}),
    onNotificationFocus: vi.fn().mockReturnValue(() => {}),
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
  useStore.setState(
    {
      ...initial,
      sessions: [],
      groups: [{ id: 'g-default', name: 'Sessions', collapsed: false, kind: 'normal' }],
      activeId: '',
      focusedGroupId: null,
      tutorialSeen: true,
      messagesBySession: {},
      startedSessions: {},
      runningSessions: {},
      messageQueues: {},
      focusInputNonce: 0
    },
    true
  );
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
});
