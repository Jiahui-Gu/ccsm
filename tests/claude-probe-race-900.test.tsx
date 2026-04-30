// Task #900 / bug #852 — gate `newSession` on the boot claudeAvailable
// probe so users can't strand themselves on a blank right pane.
//
// Bug repro before the fix: while `App.tsx`'s boot effect at lines 227-247
// is still awaiting `window.ccsmPty.checkClaudeAvailable()`,
// `claudeAvailable` is `undefined`. Clicking the sidebar `+` button (or
// the empty-state CTA) called `newSession()` → `createSession(null)` →
// the new session became active, but the right-pane render branch fell
// through to the empty `[data-testid="claude-availability-probing"]`
// spacer (no PTY ever spawned). The pane stayed blank with no user-
// visible explanation.
//
// Fix:
//   - `newSession` short-circuits when `claudeAvailable !== true`.
//   - The probing spacer now also renders a visible "Checking Claude
//     CLI…" affordance so any pre-existing active session caught in
//     the same race window has the SAME explanation surface.
//
// This test pins both behaviors against a controlled-resolution probe.
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import App from '../src/App';
import { useStore } from '../src/stores/store';
import { resetStore } from './util/resetStore';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

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

// jsdom doesn't ship Element.scrollIntoView; SessionRow calls it on
// mount when a session is selected. Shim it so the third test (which
// seeds an active session) doesn't crash before the assertions run.
function stubScrollIntoView() {
  if (!(Element.prototype as { scrollIntoView?: unknown }).scrollIntoView) {
    (Element.prototype as { scrollIntoView: () => void }).scrollIntoView = () => {};
  }
}

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

let probe: Deferred<{ available: boolean; binaryPath?: string }>;

beforeEach(() => {
  cleanup();
  probe = deferred();
  // Stub the renderer-side preload bridge that App.tsx:230 reads. The
  // boot probe awaits `bridge.checkClaudeAvailable()`; we hand back a
  // deferred so the test can control when it resolves.
  (globalThis as unknown as { window: Window & { ccsmPty?: unknown } }).window.ccsmPty = {
    checkClaudeAvailable: () => probe.promise
  };
  stubCCSM();
  stubMatchMedia();
  stubScrollIntoView();
  resetStore({
    sessions: [],
    groups: [{ id: 'g-default', name: 'Sessions', collapsed: false, kind: 'normal' }],
    activeId: '',
    focusedGroupId: null,
    tutorialSeen: true,
    hydrated: true,
    messagesBySession: {},
    startedSessions: {},
    runningSessions: {},
    messageQueues: {},
    focusInputNonce: 0
  });
});

afterEach(() => {
  cleanup();
  delete (globalThis as unknown as { window: Window & { ccsmPty?: unknown } }).window.ccsmPty;
});

describe('claude-probe race gate (#900 / #852)', () => {
  it('newSession is a no-op while the boot probe is pending', async () => {
    render(<App />);

    // Sanity: the probing-spacer also renders a visible affordance now,
    // not a blank flex spacer. (Pre-#900 behavior was a fully empty div.)
    // The empty-state branch is what shows when no session exists, so
    // we look at the right-pane CTA path: clicking it must NOT spawn a
    // session while the probe is unresolved.
    const newBtn = screen.getByRole('button', { name: /^New session$/ });
    expect(useStore.getState().sessions).toHaveLength(0);

    await act(async () => {
      fireEvent.click(newBtn);
    });

    // The gate must have suppressed createSession — store is unchanged.
    expect(useStore.getState().sessions).toHaveLength(0);
    expect(useStore.getState().activeId).toBe('');
  });

  it('newSession works once the boot probe resolves true', async () => {
    render(<App />);
    const newBtn = screen.getByRole('button', { name: /^New session$/ });

    await act(async () => {
      probe.resolve({ available: true, binaryPath: '/usr/bin/claude' });
      // Yield so the React effect's `setClaudeAvailable(true)` lands AND
      // the ref-mirror effect runs.
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(newBtn);
    });

    expect(useStore.getState().sessions.length).toBeGreaterThan(0);
  });

  it('probing-spacer surfaces a visible "Checking Claude CLI…" affordance', async () => {
    // Seed a pre-existing active session so the right pane takes the
    // claudeAvailable branch (not the first-run CTA branch). This is the
    // exact failure mode #852 reported: an active session whose right
    // pane was a blank div for the duration of the probe.
    resetStore({
      sessions: [
        {
          id: 's-pre',
          name: 'pre-existing',
          state: 'idle',
          cwd: '/',
          model: 'claude-opus-4',
          groupId: 'g-default',
          agentType: 'claude-code'
        }
      ],
      groups: [{ id: 'g-default', name: 'Sessions', collapsed: false, kind: 'normal' }],
      activeId: 's-pre',
      focusedGroupId: null,
      tutorialSeen: true,
      hydrated: true,
      messagesBySession: { 's-pre': [] },
      startedSessions: {},
      runningSessions: {},
      messageQueues: {},
      focusInputNonce: 0
    });

    render(<App />);

    // The probing-spacer is rendered (probe still pending). It must
    // contain the visible affordance, not be an empty div.
    const spacer = await screen.findByTestId('claude-availability-probing');
    expect(spacer.textContent ?? '').toMatch(/Checking Claude CLI/i);
  });

  // #910 / #911: PR #623 only gated the `+` button via App.tsx::newSession.
  // The cwd-chevron path in <Sidebar> called `createSession({ cwd })`
  // directly from a store hook, bypassing the gate. The reviewer flagged
  // this as a same-class blank-pane regression. Fix routes the chevron
  // through a sibling App.tsx wrapper (`newSessionWithCwd`) that re-checks
  // `claudeAvailableRef`. These two tests pin both halves: gate suppresses
  // the chevron path while pending; once probe resolves true, it works.
  it('cwd-chevron path is a no-op while the boot probe is pending (#911)', async () => {
    const pickCwd = vi.fn().mockResolvedValue('/picked/path');
    (window.ccsm as unknown as { pickCwd: () => Promise<string> }).pickCwd = pickCwd;

    render(<App />);

    const chevron = screen.getByTestId('sidebar-newsession-cwd-chevron');
    await act(async () => {
      fireEvent.click(chevron);
    });

    // Open the OS folder picker (Browse folder…). The handler resolves to
    // '/picked/path' and Sidebar would normally call createSession({cwd:…})
    // through the prop. With the gate in place, the wrapper short-circuits.
    const browseBtn = await screen.findByRole('button', { name: /Browse folder/i });
    await act(async () => {
      fireEvent.mouseDown(browseBtn);
      // Yield twice so the awaited pickCwd promise resolves AND the
      // subsequent gate check runs in the same microtask flush.
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(pickCwd).toHaveBeenCalledTimes(1);
    // Gate must have suppressed createSession — store unchanged.
    expect(useStore.getState().sessions).toHaveLength(0);
    expect(useStore.getState().activeId).toBe('');
  });

  it('cwd-chevron path works once the boot probe resolves true (#911)', async () => {
    const pickCwd = vi.fn().mockResolvedValue('/picked/path');
    (window.ccsm as unknown as { pickCwd: () => Promise<string> }).pickCwd = pickCwd;

    render(<App />);

    await act(async () => {
      probe.resolve({ available: true, binaryPath: '/usr/bin/claude' });
      await Promise.resolve();
      await Promise.resolve();
    });

    const chevron = screen.getByTestId('sidebar-newsession-cwd-chevron');
    await act(async () => {
      fireEvent.click(chevron);
    });

    const browseBtn = await screen.findByRole('button', { name: /Browse folder/i });
    await act(async () => {
      fireEvent.mouseDown(browseBtn);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(pickCwd).toHaveBeenCalledTimes(1);
    const sessions = useStore.getState().sessions;
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions[0].cwd).toBe('/picked/path');
  });
});
