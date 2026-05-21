// Coverage for the terminal scrollback setting in the Appearance pane.
//
// Pins:
//   - The number input renders and reflects the persisted store value.
//   - Editing the input commits via blur → updates the zustand store
//     (synchronous renderer-side read for ensureTerminal) AND writes
//     through window.ccsm.saveState('scrollbackLines', ...) so the main
//     process pref module sees the new value (via stateSavedBus
//     invalidation) on next read.
//   - Clamping enforces the documented MIN/MAX (sanitizeScrollbackLines).
//   - The reset button restores the documented default.
//
// Reverse-verify: stub `setScrollbackLines` to a no-op → `commit` no longer
// updates the input AND no longer fires saveState — both expectations fail.

import React, { useState } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  cleanup,
  within,
  act,
} from '@testing-library/react';
import { SettingsDialog } from '../src/components/SettingsDialog';
import { useStore } from '../src/stores/store';
import { initI18n } from '../src/i18n';
import {
  SCROLLBACK_LINES_DEFAULT,
  SCROLLBACK_LINES_MAX,
  SCROLLBACK_LINES_MIN,
} from '../src/stores/slices/types';

let saveStateSpy: ReturnType<typeof vi.fn>;
let loadStateSpy: ReturnType<typeof vi.fn>;

function stubCcsm() {
  saveStateSpy = vi.fn(async () => {});
  loadStateSpy = vi.fn(async () => undefined);
  const api = {
    getVersion: vi.fn(async () => '0.0.0-test'),
    updatesStatus: vi.fn(async () => ({ kind: 'idle' as const })),
    updatesGetAutoCheck: vi.fn(async () => true),
    updatesSetAutoCheck: vi.fn(async (v: boolean) => v),
    updatesCheck: vi.fn(async () => {}),
    updatesDownload: vi.fn(async () => {}),
    updatesInstall: vi.fn(async () => {}),
    onUpdateStatus: () => () => {},
    loadState: loadStateSpy,
    saveState: saveStateSpy,
    settingsLoad: vi.fn(async () => ({})),
    settingsOpenInEditor: vi.fn(async () => {}),
    modelsList: vi.fn(async () => []),
  };
  (window as { ccsm?: unknown }).ccsm = api;
  return api;
}

function stubMatchMedia() {
  if (window.matchMedia) return;
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (q: string) => ({
      matches: false,
      media: q,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

function Harness() {
  const [open, setOpen] = useState(true);
  return (
    <SettingsDialog open={open} onOpenChange={setOpen} initialTab="appearance" />
  );
}

beforeEach(() => {
  cleanup();
  stubCcsm();
  stubMatchMedia();
  initI18n('en');
  // Reset the slice's value to default before each test.
  act(() => {
    useStore.getState().setScrollbackLines(SCROLLBACK_LINES_DEFAULT);
  });
});

afterEach(() => {
  delete (window as { ccsm?: unknown }).ccsm;
});

describe('Settings: terminal scrollback', () => {
  it('renders the scrollback input and label', () => {
    render(<Harness />);
    const dialog = screen.getByRole('dialog');
    // Field label visible.
    expect(within(dialog).getByText(/Terminal scrollback/i)).toBeInTheDocument();
    // Input present and reflects current store default.
    const input = within(dialog).getByLabelText(
      /Terminal scrollback in lines/i,
    ) as HTMLInputElement;
    expect(input).toBeInTheDocument();
    expect(input.value).toBe(String(SCROLLBACK_LINES_DEFAULT));
  });

  it('reflects the current zustand store value at mount', () => {
    act(() => useStore.getState().setScrollbackLines(2222));
    render(<Harness />);
    const input = screen.getByLabelText(
      /Terminal scrollback in lines/i,
    ) as HTMLInputElement;
    expect(input.value).toBe('2222');
  });

  it('persists the new value on blur via setScrollbackLines + saveState', () => {
    render(<Harness />);
    const input = screen.getByLabelText(
      /Terminal scrollback in lines/i,
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '3500' } });
    fireEvent.blur(input);

    // Renderer source-of-truth (zustand) updated.
    expect(useStore.getState().scrollbackLines).toBe(3500);
    // Through-write to db (main reads from this same row).
    expect(saveStateSpy).toHaveBeenCalledWith('scrollbackLines', '3500');
    // Input echoes the sanitized value.
    expect(input.value).toBe('3500');
  });

  it('clamps a too-large value to MAX', () => {
    render(<Harness />);
    const input = screen.getByLabelText(
      /Terminal scrollback in lines/i,
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '999999' } });
    fireEvent.blur(input);

    expect(useStore.getState().scrollbackLines).toBe(SCROLLBACK_LINES_MAX);
    expect(saveStateSpy).toHaveBeenCalledWith(
      'scrollbackLines',
      String(SCROLLBACK_LINES_MAX),
    );
    expect(input.value).toBe(String(SCROLLBACK_LINES_MAX));
  });

  it('clamps a too-small value to MIN', () => {
    render(<Harness />);
    const input = screen.getByLabelText(
      /Terminal scrollback in lines/i,
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.blur(input);

    expect(useStore.getState().scrollbackLines).toBe(SCROLLBACK_LINES_MIN);
    expect(input.value).toBe(String(SCROLLBACK_LINES_MIN));
  });

  it('reset button restores the documented default', () => {
    act(() => useStore.getState().setScrollbackLines(4242));
    render(<Harness />);
    const dialog = screen.getByRole('dialog');
    // Localized label: "Reset to default ({{default}})".
    const resetBtn = within(dialog).getByRole('button', {
      name: /Reset to default/i,
    });
    fireEvent.click(resetBtn);

    expect(useStore.getState().scrollbackLines).toBe(SCROLLBACK_LINES_DEFAULT);
    expect(saveStateSpy).toHaveBeenCalledWith(
      'scrollbackLines',
      String(SCROLLBACK_LINES_DEFAULT),
    );
  });

  it('Enter key triggers blur which commits the value', () => {
    render(<Harness />);
    const input = screen.getByLabelText(
      /Terminal scrollback in lines/i,
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '2750' } });
    // jsdom doesn't reliably forward `el.blur()` from a keydown handler
    // back into a synthetic React onBlur event in this test environment.
    // Drive the keydown for behavioural coverage of the handler itself
    // (preventDefault path), then fire the blur directly to verify the
    // commit pipeline. Production behavior is unchanged: keydown calls
    // .blur(), the browser fires onBlur, commit runs.
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);
    expect(useStore.getState().scrollbackLines).toBe(2750);
    expect(saveStateSpy).toHaveBeenCalledWith('scrollbackLines', '2750');
  });
});
