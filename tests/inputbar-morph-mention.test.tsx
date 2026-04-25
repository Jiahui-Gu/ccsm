// Component tests for the InputBar additions in feat/composer-morph-mention:
//   - send/stop morph button: same DOM slot, icon + variant + aria-label
//     swap based on the running flag (mirrors the upstream Anthropic
//     Claude Code VS Code extension's webview button)
//   - @file mention picker: typing `@` opens a listbox; Esc dismisses;
//     selecting an entry splices `@<path> ` into the textarea
//
// Mirrors `tests/inputbar.test.tsx` setup so we keep the renderer-only
// shortcut: real Zustand store, stubbed `window.ccsm`, no Electron.

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act, cleanup, waitFor } from '@testing-library/react';
import { InputBar } from '../src/components/InputBar';
import { useStore } from '../src/stores/store';

const initial = useStore.getState();

function freshStoreWithSession(sessionId: string, opts: { running?: boolean; started?: boolean } = {}) {
  useStore.setState(
    {
      ...initial,
      sessions: [
        {
          id: sessionId,
          name: sessionId,
          state: 'idle',
          cwd: '~',
          model: 'claude',
          groupId: 'g-default',
          agentType: 'claude-code'
        }
      ],
      groups: [{ id: 'g-default', name: 'Sessions', collapsed: false, kind: 'normal' }],
      activeId: sessionId,
      messagesBySession: {},
      startedSessions: opts.started ? { [sessionId]: true } : {},
      runningSessions: opts.running ? { [sessionId]: true } : {},
      messageQueues: {},
      focusInputNonce: 0
    },
    true
  );
}

function stubCCSM(overrides: Partial<Record<string, unknown>> = {}) {
  const filesList = vi.fn().mockResolvedValue([
    { path: 'src/InputBar.tsx', name: 'InputBar.tsx' },
    { path: 'src/MentionPicker.tsx', name: 'MentionPicker.tsx' },
    { path: 'README.md', name: 'README.md' },
  ]);
  const api = {
    agentInterrupt: vi.fn().mockResolvedValue(undefined),
    agentSend: vi.fn().mockResolvedValue(true),
    agentSendContent: vi.fn().mockResolvedValue(true),
    agentStart: vi.fn().mockResolvedValue({ ok: true }),
    files: { list: filesList },
    commands: { list: vi.fn().mockResolvedValue([]) },
    ...overrides
  };
  (globalThis as unknown as { window: Window & { ccsm?: unknown } }).window.ccsm = api;
  return api;
}

beforeEach(() => {
  cleanup();
  (globalThis as unknown as { window: Window & { ccsm?: unknown } }).window.ccsm = undefined;
});

describe('InputBar: send/stop morph button', () => {
  it('renders the Send affordance when the session is idle', () => {
    freshStoreWithSession('s-morph-idle', { running: false, started: true });
    stubCCSM();
    render(<InputBar sessionId="s-morph-idle" />);
    const morph = screen.getByRole('button', { name: /send message/i });
    expect(morph).toBeInTheDocument();
    expect(morph).toHaveAttribute('data-morph-state', 'send');
    expect(morph).toHaveAttribute('data-variant', 'primary');
  });

  it('morphs to the Stop affordance when the session is running', () => {
    freshStoreWithSession('s-morph-run', { running: true, started: true });
    stubCCSM();
    render(<InputBar sessionId="s-morph-run" />);
    const morph = screen.getByRole('button', { name: /^stop$/i });
    expect(morph).toBeInTheDocument();
    expect(morph).toHaveAttribute('data-morph-state', 'stop');
    expect(morph).toHaveAttribute('data-variant', 'danger');
  });

  it('clicking the morph button while running fires agentInterrupt', () => {
    freshStoreWithSession('s-morph-stop', { running: true, started: true });
    const api = stubCCSM();
    render(<InputBar sessionId="s-morph-stop" />);
    const stop = screen.getByRole('button', { name: /^stop$/i });
    act(() => {
      fireEvent.click(stop);
    });
    expect(api.agentInterrupt).toHaveBeenCalledWith('s-morph-stop');
  });
});

describe('InputBar: @file mention picker', () => {
  it('opens the mention picker when the user types @', async () => {
    freshStoreWithSession('s-at', { running: false, started: true });
    stubCCSM();
    render(<InputBar sessionId="s-at" />);
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    act(() => {
      fireEvent.change(ta, { target: { value: '@' } });
      // Caret sync — the InputBar reads selectionStart on change, but we
      // also bump it via a Click for good measure.
      ta.setSelectionRange(1, 1);
      fireEvent.click(ta);
    });
    await waitFor(() => {
      expect(screen.getByRole('listbox', { name: /file mentions/i })).toBeInTheDocument();
    });
    // At least one mention row should be rendered.
    const opts = screen.getAllByRole('option');
    expect(opts.length).toBeGreaterThan(0);
  });

  it('Esc dismisses the mention picker without changing the textarea', async () => {
    freshStoreWithSession('s-at-esc', { running: false, started: true });
    stubCCSM();
    render(<InputBar sessionId="s-at-esc" />);
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    act(() => {
      fireEvent.change(ta, { target: { value: '@' } });
      ta.setSelectionRange(1, 1);
      fireEvent.click(ta);
    });
    await waitFor(() => screen.getByRole('listbox', { name: /file mentions/i }));
    act(() => {
      fireEvent.keyDown(ta, { key: 'Escape' });
    });
    expect(screen.queryByRole('listbox', { name: /file mentions/i })).not.toBeInTheDocument();
    expect(ta.value).toBe('@');
  });

  it('Enter on a highlighted row splices @<path> into the textarea', async () => {
    freshStoreWithSession('s-at-pick', { running: false, started: true });
    stubCCSM();
    render(<InputBar sessionId="s-at-pick" />);
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    act(() => {
      fireEvent.change(ta, { target: { value: '@' } });
      ta.setSelectionRange(1, 1);
      fireEvent.click(ta);
    });
    await waitFor(() => screen.getByRole('listbox', { name: /file mentions/i }));
    act(() => {
      fireEvent.keyDown(ta, { key: 'Enter' });
    });
    // The first row in the picker (no query) is the first WorkspaceFile we
    // stubbed: src/InputBar.tsx. After commit, the textarea contains
    // `@src/InputBar.tsx ` (with trailing space).
    expect(ta.value).toBe('@src/InputBar.tsx ');
    // Picker auto-dismisses after selection.
    expect(screen.queryByRole('listbox', { name: /file mentions/i })).not.toBeInTheDocument();
  });
});
