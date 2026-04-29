// Audit gap fill (PR #568, language-toggle a1-a3): the deleted e2e probe
// asserted that the live App shell's Sidebar `Settings` button text and the
// search aria-label flip en→zh→en when the user changes language via the
// preferences store. The migration target `tests/language-switch.test.tsx`
// only covers the bare `t()` token through useTranslation — it never renders
// a Sidebar consumer. So the real wiring (useTranslation re-subscribing on
// the i18next `languageChanged` event, Sidebar re-rendering with the new
// strings) had ZERO coverage post-#568.
//
// This test renders the actual <Sidebar /> with both English and Chinese
// catalogs loaded, flips language through the preferences store, and asserts
// the visible Settings button text + search-icon aria-label re-render. We
// flip back to en at the end so a one-way binding (e.g. a stale closure
// over the en t function) would also fail.
import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { Sidebar } from '../src/components/Sidebar';
import { useStore } from '../src/stores/store';
import { usePreferences } from '../src/store/preferences';
import { initI18n } from '../src/i18n';
import { ToastProvider } from '../src/components/ui/Toast';

const initial = useStore.getState();

function stubCCSM() {
  const api = {
    window: {
      // Sidebar reads window.ccsm?.window.platform to decide DragRegion height
      // (40 on darwin, 8 elsewhere). We're not on darwin.
      platform: 'win32',
    },
  };
  (globalThis as unknown as { window: Window & { ccsm?: unknown } }).window.ccsm = api;
}

beforeEach(() => {
  initI18n('en');
  cleanup();
  // Reset language to en before each test so the inverse test direction
  // doesn't depend on test ordering.
  act(() => {
    usePreferences.getState().setLanguage('en');
  });
  useStore.setState(
    {
      ...initial,
      sessions: [],
      groups: [{ id: 'g-default', name: 'Sessions', collapsed: false, kind: 'normal' }],
      activeId: '',
      focusedGroupId: null,
      sidebarCollapsed: false,
      hydrated: true,
    } as ReturnType<typeof useStore.getState>,
    true
  );
  stubCCSM();
});

afterEach(() => {
  // Always leave the global preference back at en for other test files.
  act(() => {
    usePreferences.getState().setLanguage('en');
  });
  cleanup();
});

function renderSidebar() {
  return render(
    <ToastProvider>
      <Sidebar
        activeSessionId=""
        focusedGroupId={null}
        sessions={[]}
        onSelectSession={() => {}}
        onFocusGroup={() => {}}
        onMoveSession={() => {}}
        onCreateSession={() => {}}
        onOpenSettings={() => {}}
        onOpenPalette={() => {}}
        onOpenImport={() => {}}
      />
    </ToastProvider>
  );
}

describe('Sidebar i18n live-flip (language-toggle a1-a3)', () => {
  it('Settings button text and search aria-label re-render en → zh → en', async () => {
    renderSidebar();

    // Default: English.
    expect(screen.getByRole('button', { name: /^Settings$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Search$/ })).toBeInTheDocument();
    // The 中文 strings must NOT yet be present.
    expect(screen.queryByRole('button', { name: '设置' })).not.toBeInTheDocument();

    // Flip to Chinese via the preferences store. setLanguage triggers
    // i18next.changeLanguage which fires the `languageChanged` event that
    // useTranslation subscribes to; the Sidebar must re-render with zh.
    await act(async () => {
      usePreferences.getState().setLanguage('zh');
    });

    expect(screen.getByRole('button', { name: '设置' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '搜索' })).toBeInTheDocument();
    // English strings are gone.
    expect(screen.queryByRole('button', { name: /^Settings$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Search$/ })).not.toBeInTheDocument();

    // And back, to confirm it isn't a one-way door (a stale en closure would
    // pass the first flip but fail this one).
    await act(async () => {
      usePreferences.getState().setLanguage('en');
    });

    expect(screen.getByRole('button', { name: /^Settings$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Search$/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '设置' })).not.toBeInTheDocument();
  });
});
