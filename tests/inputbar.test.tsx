// Component tests for InputBar focused on the CLI-style affordances:
//  - Esc-to-interrupt fires `agentInterrupt` while running and is silent otherwise
//  - Send-while-running enqueues into the per-session FIFO instead of dispatching
//  - Stop clears the queue (matches CLI Ctrl+C dropping pending input)
//  - The +N queued chip surfaces queue depth
//
// We render <InputBar /> against the real Zustand store and stub `window.agentory`
// to capture IPC calls. This is intentionally not a probe — we want fast feedback
// on the keyboard plumbing without spinning up Electron.
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
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

function stubAgentory(overrides: Partial<Record<string, unknown>> = {}) {
  const api = {
    agentInterrupt: vi.fn().mockResolvedValue(undefined),
    agentSend: vi.fn().mockResolvedValue(true),
    agentSendContent: vi.fn().mockResolvedValue(true),
    agentStart: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides
  };
  (globalThis as unknown as { window: Window & { agentory?: unknown } }).window.agentory = api;
  return api;
}

beforeEach(() => {
  cleanup();
  (globalThis as unknown as { window: Window & { agentory?: unknown } }).window.agentory = undefined;
});

describe('InputBar: Esc to interrupt running turn', () => {
  it('Esc fires agentInterrupt when the session is running', () => {
    freshStoreWithSession('s-esc', { running: true, started: true });
    const api = stubAgentory();
    render(<InputBar sessionId="s-esc" />);
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(api.agentInterrupt).toHaveBeenCalledWith('s-esc');
    // markInterrupted side-effect — verifies stop() ran the full sequence.
    expect(useStore.getState().interruptedSessions['s-esc']).toBe(true);
  });

  it('Esc is a no-op when the session is NOT running', () => {
    freshStoreWithSession('s-idle', { running: false, started: true });
    const api = stubAgentory();
    render(<InputBar sessionId="s-idle" />);
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(api.agentInterrupt).not.toHaveBeenCalled();
  });

  it('Esc yields to an open Radix dialog (lets the dialog close itself)', () => {
    freshStoreWithSession('s-modal', { running: true, started: true });
    const api = stubAgentory();
    render(<InputBar sessionId="s-modal" />);
    // Inject a fake dialog element — the global handler must back off when one
    // is present so settings/command-palette Esc-to-close still works.
    const fakeDialog = document.createElement('div');
    fakeDialog.setAttribute('role', 'dialog');
    document.body.appendChild(fakeDialog);
    try {
      act(() => {
        fireEvent.keyDown(document, { key: 'Escape' });
      });
      expect(api.agentInterrupt).not.toHaveBeenCalled();
    } finally {
      fakeDialog.remove();
    }
  });
});

describe('InputBar: send-while-running enqueues into FIFO', () => {
  it('typing + Send while running enqueues instead of calling agentSend', () => {
    freshStoreWithSession('s-q', { running: true, started: true });
    const api = stubAgentory();
    render(<InputBar sessionId="s-q" />);
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'queued thought' } });
    // Press Enter to submit (existing send keybind).
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(api.agentSend).not.toHaveBeenCalled();
    const q = useStore.getState().messageQueues['s-q'];
    expect(q).toHaveLength(1);
    expect(q[0].text).toBe('queued thought');
    // Composer cleared after enqueue so the user can type the next thought.
    expect((ta as HTMLTextAreaElement).value).toBe('');
  });

  it('renders a +N queued chip reflecting queue length', () => {
    freshStoreWithSession('s-chip', { running: true, started: true });
    stubAgentory();
    act(() => {
      useStore.getState().enqueueMessage('s-chip', { text: 'first', attachments: [] });
      useStore.getState().enqueueMessage('s-chip', { text: 'second', attachments: [] });
    });
    render(<InputBar sessionId="s-chip" />);
    expect(screen.getByText('+2 queued')).toBeInTheDocument();
  });

  it('Stop clears the queue (CLI Ctrl+C behavior)', async () => {
    freshStoreWithSession('s-stop', { running: true, started: true });
    const api = stubAgentory();
    render(<InputBar sessionId="s-stop" />);
    act(() => {
      useStore.getState().enqueueMessage('s-stop', { text: 'pending', attachments: [] });
    });
    expect(useStore.getState().messageQueues['s-stop']).toHaveLength(1);
    // Click the visible Stop button.
    const stopBtn = screen.getByRole('button', { name: /stop/i });
    await act(async () => {
      fireEvent.click(stopBtn);
    });
    expect(api.agentInterrupt).toHaveBeenCalledWith('s-stop');
    expect(useStore.getState().messageQueues['s-stop']).toBeUndefined();
  });
});

describe('InputBar: textarea remains editable while running', () => {
  it('does not set the disabled attribute on the textarea during a running turn', () => {
    freshStoreWithSession('s-edit', { running: true, started: true });
    stubAgentory();
    render(<InputBar sessionId="s-edit" />);
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(ta.disabled).toBe(false);
    fireEvent.change(ta, { target: { value: 'still typing' } });
    expect(ta.value).toBe('still typing');
  });
});
