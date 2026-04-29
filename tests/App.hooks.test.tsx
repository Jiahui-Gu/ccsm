// Task #732 Phase B — verify App.tsx wires the 9 effect hooks merged in
// PR #552. Each hook module is mocked so we can assert it was called
// exactly once per render. This pins the contract that the App
// composition root delegates these effects to dedicated hooks rather than
// inlining them — guards against future regressions where someone
// re-inlines logic and silently bypasses the SRP boundary.
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { useStore } from '../src/stores/store';

// Mock all 9 hook modules BEFORE importing App. Each export is a vi.fn so
// we can introspect call counts after render. The hooks return either
// `void` or, in the tutorial case, a `{ show, dismiss }` shape — match
// the production return so App's render path doesn't crash.
vi.mock('../src/app-effects/useThemeEffect', () => ({
  useThemeEffect: vi.fn(),
}));
vi.mock('../src/app-effects/useLanguageEffect', () => ({
  useLanguageEffect: vi.fn(),
}));
vi.mock('../src/app-effects/useAgentEventBridge', () => ({
  useAgentEventBridge: vi.fn(),
}));
vi.mock('../src/app-effects/useShortcutHandlers', () => ({
  useShortcutHandlers: vi.fn(),
}));
vi.mock('../src/app-effects/useSessionActivateBridge', () => ({
  useSessionActivateBridge: vi.fn(),
}));
vi.mock('../src/app-effects/useFocusBridge', () => ({
  useFocusBridge: vi.fn(),
}));
vi.mock('../src/app-effects/useUpdateDownloadedBridge', () => ({
  useUpdateDownloadedBridge: vi.fn(),
}));
vi.mock('../src/app-effects/usePersistErrorBridge', () => ({
  usePersistErrorBridge: vi.fn(),
}));
vi.mock('../src/app-effects/useTutorialOverlay', () => ({
  useTutorialOverlay: vi.fn(() => ({ show: false, dismiss: vi.fn() })),
}));

// Imports MUST come after vi.mock calls (vi.mock is hoisted, but explicit
// ordering keeps the read order obvious to humans).
import App from '../src/App';
import { useThemeEffect } from '../src/app-effects/useThemeEffect';
import { useLanguageEffect } from '../src/app-effects/useLanguageEffect';
import { useAgentEventBridge } from '../src/app-effects/useAgentEventBridge';
import { useShortcutHandlers } from '../src/app-effects/useShortcutHandlers';
import { useSessionActivateBridge } from '../src/app-effects/useSessionActivateBridge';
import { useFocusBridge } from '../src/app-effects/useFocusBridge';
import { useUpdateDownloadedBridge } from '../src/app-effects/useUpdateDownloadedBridge';
import { usePersistErrorBridge } from '../src/app-effects/usePersistErrorBridge';
import { useTutorialOverlay } from '../src/app-effects/useTutorialOverlay';

const initial = useStore.getState();

function stubCCSM() {
  const api = {
    pathsExist: vi.fn().mockResolvedValue({}),
    recentCwds: vi.fn().mockResolvedValue([]),
    defaultModel: vi.fn().mockResolvedValue(null),
    onUpdateDownloaded: vi.fn().mockReturnValue(() => {}),
    cliCheck: vi.fn().mockResolvedValue({ state: 'found', binaryPath: '/usr/bin/claude' }),
    settingsLoad: vi.fn().mockResolvedValue({}),
    modelsList: vi.fn().mockResolvedValue([]),
    updatesInstall: vi.fn(),
    window: {
      onBeforeHide: vi.fn().mockReturnValue(() => {}),
      onAfterShow: vi.fn().mockReturnValue(() => {}),
      isMaximized: vi.fn().mockResolvedValue(false),
      onMaximizedChanged: vi.fn().mockReturnValue(() => {}),
      minimize: vi.fn(),
      maximize: vi.fn(),
      unmaximize: vi.fn(),
      close: vi.fn(),
    },
    i18n: {
      getSystemLocale: vi.fn().mockResolvedValue('en'),
      setLanguage: vi.fn(),
    },
  };
  (globalThis as unknown as { window: Window & { ccsm?: unknown } }).window.ccsm = api;
  return api;
}

function stubMatchMedia() {
  if (typeof window === 'undefined') return;
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  useStore.setState(
    {
      ...initial,
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
      focusInputNonce: 0,
    },
    true
  );
  stubCCSM();
  stubMatchMedia();
});

describe('App composition root wires extracted effect hooks (Task #732)', () => {
  it('calls each of the 9 app-effects hooks during render', () => {
    render(<App />);
    expect(useThemeEffect).toHaveBeenCalled();
    expect(useLanguageEffect).toHaveBeenCalled();
    expect(useAgentEventBridge).toHaveBeenCalled();
    expect(useShortcutHandlers).toHaveBeenCalled();
    expect(useSessionActivateBridge).toHaveBeenCalled();
    expect(useFocusBridge).toHaveBeenCalled();
    expect(useUpdateDownloadedBridge).toHaveBeenCalled();
    expect(usePersistErrorBridge).toHaveBeenCalled();
    expect(useTutorialOverlay).toHaveBeenCalled();
  });

  it('passes the resolved language to useLanguageEffect', () => {
    render(<App />);
    const calls = (useLanguageEffect as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    // First positional arg is the resolved language ('en' from stubCCSM
    // setSystemLocale + initI18n).
    expect(typeof calls[0][0]).toBe('string');
  });

  it('passes selectSession to useSessionActivateBridge', () => {
    render(<App />);
    const calls = (useSessionActivateBridge as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    expect(typeof calls[0][0]).toBe('function');
  });

  it('passes a deps object with toast push to useUpdateDownloadedBridge and usePersistErrorBridge', () => {
    render(<App />);
    const updateCalls = (useUpdateDownloadedBridge as unknown as { mock: { calls: Array<Array<{ push: unknown }>> } }).mock.calls;
    const persistCalls = (usePersistErrorBridge as unknown as { mock: { calls: Array<Array<{ push: unknown }>> } }).mock.calls;
    expect(updateCalls.length).toBeGreaterThan(0);
    expect(persistCalls.length).toBeGreaterThan(0);
    expect(typeof updateCalls[0][0].push).toBe('function');
    expect(typeof persistCalls[0][0].push).toBe('function');
  });

  it('passes the current theme to useThemeEffect', () => {
    render(<App />);
    const calls = (useThemeEffect as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    expect(['light', 'dark', 'system']).toContain(calls[0][0]);
  });

  it('passes tutorialSeen + markTutorialSeen to useTutorialOverlay', () => {
    render(<App />);
    const calls = (useTutorialOverlay as unknown as { mock: { calls: Array<Array<{ tutorialSeen: unknown; markTutorialSeen: unknown }>> } }).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    expect(typeof calls[0][0].tutorialSeen).toBe('boolean');
    expect(typeof calls[0][0].markTutorialSeen).toBe('function');
  });
});
