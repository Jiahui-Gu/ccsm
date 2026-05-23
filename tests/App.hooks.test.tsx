// Task #732 Phase B + Task #758 Phase C — verify App.tsx wires the
// extracted effect hooks merged in PR #552 / PR #559 / PR #758. Each hook
// module is mocked so we can assert it was called exactly once per render.
// This pins the contract that the App composition root delegates these
// effects to dedicated hooks rather than inlining them — guards against
// future regressions where someone re-inlines logic and silently bypasses
// the SRP boundary.
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { resetStore } from './util/resetStore';

// Mock all hook modules BEFORE importing App. Each export is a vi.fn so
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
// Phase C hooks (Task #758).
vi.mock('../src/app-effects/useSessionActiveBridge', () => ({
  useSessionActiveBridge: vi.fn(),
}));
vi.mock('../src/app-effects/useSessionNameBridge', () => ({
  useSessionNameBridge: vi.fn(),
}));
vi.mock('../src/app-effects/usePtyExitBridge', () => ({
  usePtyExitBridge: vi.fn(),
}));
vi.mock('../src/app-effects/useSessionTitleBridge', () => ({
  useSessionTitleBridge: vi.fn(),
}));
vi.mock('../src/app-effects/useNotifyFlashBridge', () => ({
  useNotifyFlashBridge: vi.fn(),
}));
vi.mock('../src/app-effects/useCwdRedirectedBridge', () => ({
  useCwdRedirectedBridge: vi.fn(),
}));
vi.mock('../src/app-effects/useHydrateSystemLocale', () => ({
  useHydrateSystemLocale: vi.fn(),
}));
vi.mock('../src/app-effects/useExitAnimation', () => ({
  useExitAnimation: vi.fn(),
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
import { useSessionActiveBridge } from '../src/app-effects/useSessionActiveBridge';
import { useSessionNameBridge } from '../src/app-effects/useSessionNameBridge';
import { usePtyExitBridge } from '../src/app-effects/usePtyExitBridge';
import { useSessionTitleBridge } from '../src/app-effects/useSessionTitleBridge';
import { useNotifyFlashBridge } from '../src/app-effects/useNotifyFlashBridge';
import { useCwdRedirectedBridge } from '../src/app-effects/useCwdRedirectedBridge';
import { useHydrateSystemLocale } from '../src/app-effects/useHydrateSystemLocale';
import { useExitAnimation } from '../src/app-effects/useExitAnimation';

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
    focusInputNonce: 0,
  });
  stubCCSM();
  stubMatchMedia();
});

describe('App composition root wires extracted effect hooks (Task #732)', () => {
  it('calls each of the 8 Phase A/B app-effects hooks during render', () => {
    render(<App />);
    expect(useThemeEffect).toHaveBeenCalled();
    expect(useLanguageEffect).toHaveBeenCalled();
    expect(useAgentEventBridge).toHaveBeenCalled();
    expect(useShortcutHandlers).toHaveBeenCalled();
    expect(useSessionActivateBridge).toHaveBeenCalled();
    expect(useFocusBridge).toHaveBeenCalled();
    expect(useUpdateDownloadedBridge).toHaveBeenCalled();
    expect(usePersistErrorBridge).toHaveBeenCalled();
  });

  it('passes the resolved language to useLanguageEffect', () => {
    render(<App />);
    const calls = (useLanguageEffect as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    // App renders twice during boot: initial render, then a re-render
    // triggered by a setState landing from the boot effect chain (e.g.
    // claudeAvailable resolution, settings load). Each hook fires exactly
    // once per render → exact count is 2, not >0. Pinning the exact count
    // would catch a regression that adds a stray render or double-fires
    // a hook.
    expect(useLanguageEffect).toHaveBeenCalledTimes(2);
    // jsdom navigator.language is 'en-US' → resolveLanguage('system', 'en-US')
    // returns 'en'. Assert the EXACT resolved value, not just "is a string"
    // (which would pass for '' or 'fr' — both of which would be bugs).
    expect(calls[0][0]).toBe('en');
    expect(calls[1][0]).toBe('en');
  });

  it('passes selectSession to useSessionActivateBridge', () => {
    render(<App />);
    const calls = (useSessionActivateBridge as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(useSessionActivateBridge).toHaveBeenCalledTimes(2);
    expect(typeof calls[0][0]).toBe('function');
  });

  it('passes a deps object with toast push to useUpdateDownloadedBridge and usePersistErrorBridge', () => {
    render(<App />);
    const updateCalls = (useUpdateDownloadedBridge as unknown as { mock: { calls: Array<Array<{ push: unknown }>> } }).mock.calls;
    const persistCalls = (usePersistErrorBridge as unknown as { mock: { calls: Array<Array<{ push: unknown }>> } }).mock.calls;
    expect(useUpdateDownloadedBridge).toHaveBeenCalledTimes(2);
    expect(usePersistErrorBridge).toHaveBeenCalledTimes(2);
    expect(typeof updateCalls[0][0].push).toBe('function');
    expect(typeof persistCalls[0][0].push).toBe('function');
  });

  it('passes the current theme to useThemeEffect', () => {
    render(<App />);
    const calls = (useThemeEffect as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(useThemeEffect).toHaveBeenCalledTimes(2);
    expect(['light', 'dark', 'system']).toContain(calls[0][0]);
  });
});

describe('App composition root wires Phase C effect hooks (Task #758)', () => {
  it('calls each of the 8 Phase C app-effects hooks during render', () => {
    render(<App />);
    expect(useSessionActiveBridge).toHaveBeenCalled();
    expect(useSessionNameBridge).toHaveBeenCalled();
    expect(usePtyExitBridge).toHaveBeenCalled();
    expect(useSessionTitleBridge).toHaveBeenCalled();
    expect(useNotifyFlashBridge).toHaveBeenCalled();
    expect(useCwdRedirectedBridge).toHaveBeenCalled();
    expect(useHydrateSystemLocale).toHaveBeenCalled();
    expect(useExitAnimation).toHaveBeenCalled();
  });

  it('passes activeId (string or null/empty) to useSessionActiveBridge', () => {
    render(<App />);
    const calls = (useSessionActiveBridge as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(useSessionActiveBridge).toHaveBeenCalledTimes(2);
    // activeId is '' on the empty fixture; assert the exact value passed
    // (the empty-string sentinel for "no active session").
    expect(calls[0][0]).toBe('');
  });

  it('passes the sessions array to useSessionNameBridge', () => {
    render(<App />);
    const calls = (useSessionNameBridge as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(useSessionNameBridge).toHaveBeenCalledTimes(2);
    // Empty fixture → empty sessions array.
    expect(calls[0][0]).toEqual([]);
  });

  it('passes store action functions to the IPC-bridge hooks that take a callback', () => {
    render(<App />);
    const ptyCalls = (usePtyExitBridge as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const titleCalls = (useSessionTitleBridge as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const cwdCalls = (useCwdRedirectedBridge as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const hydrateCalls = (useHydrateSystemLocale as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(usePtyExitBridge).toHaveBeenCalledTimes(2);
    expect(useSessionTitleBridge).toHaveBeenCalledTimes(2);
    expect(useCwdRedirectedBridge).toHaveBeenCalledTimes(2);
    expect(useHydrateSystemLocale).toHaveBeenCalledTimes(2);
    expect(typeof ptyCalls[0][0]).toBe('function');
    expect(typeof titleCalls[0][0]).toBe('function');
    expect(typeof cwdCalls[0][0]).toBe('function');
    expect(typeof hydrateCalls[0][0]).toBe('function');
  });

  it('useNotifyFlashBridge and useExitAnimation take no args (zero-arg subscriptions)', () => {
    render(<App />);
    const flashCalls = (useNotifyFlashBridge as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const exitCalls = (useExitAnimation as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(useNotifyFlashBridge).toHaveBeenCalledTimes(2);
    expect(useExitAnimation).toHaveBeenCalledTimes(2);
    expect(flashCalls[0].length).toBe(0);
    expect(exitCalls[0].length).toBe(0);
  });
});
