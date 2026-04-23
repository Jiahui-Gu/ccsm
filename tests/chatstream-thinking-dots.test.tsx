import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Same xterm shims as chatstream-terminal.test.tsx — ChatStream pulls Terminal
// at module-eval, so the mocks must be installed before the import runs even
// if no test in this file exercises a Bash block.
vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn().mockImplementation(() => ({
    open: vi.fn(),
    write: vi.fn(),
    reset: vi.fn(),
    dispose: vi.fn(),
    resize: vi.fn(),
    loadAddon: vi.fn(),
    cols: 80,
    rows: 10
  }))
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn().mockImplementation(() => ({
    fit: vi.fn(),
    proposeDimensions: () => ({ cols: 80, rows: 10 })
  }))
}));
vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: vi.fn().mockImplementation(() => ({}))
}));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

class StubResizeObserver {
  observe(): void {}
  disconnect(): void {}
}
beforeEach(() => {
  (globalThis as unknown as { ResizeObserver: typeof StubResizeObserver }).ResizeObserver =
    StubResizeObserver;
});

import { render, cleanup } from '@testing-library/react';
import { ChatStream } from '../src/components/ChatStream';
import { useStore } from '../src/stores/store';
import type { MessageBlock } from '../src/types';

const initial = useStore.getState();

afterEach(() => cleanup());

function seed(opts: { blocks: MessageBlock[]; running: boolean }) {
  useStore.setState(
    {
      ...initial,
      activeId: 's1',
      messagesBySession: { s1: opts.blocks },
      runningSessions: opts.running ? { s1: true } : {}
    },
    true
  );
}

describe('ChatStream thinking dots indicator', () => {
  it('renders dots when agent is running and last block is the user message (waiting for first token)', () => {
    seed({
      running: true,
      blocks: [{ kind: 'user', id: 'u1', text: 'Explain TCP handshake' }]
    });
    const { container } = render(<ChatStream />);
    expect(container.querySelector('[data-testid="chat-thinking-dots"]')).toBeTruthy();
  });

  it('renders dots when agent is running and the session has no blocks yet', () => {
    seed({ running: true, blocks: [] });
    const { container } = render(<ChatStream />);
    expect(container.querySelector('[data-testid="chat-thinking-dots"]')).toBeTruthy();
  });

  it('hides dots once the assistant block starts streaming', () => {
    seed({
      running: true,
      blocks: [
        { kind: 'user', id: 'u1', text: 'Explain TCP handshake' },
        { kind: 'assistant', id: 'a1', text: 'The three-way', streaming: true }
      ]
    });
    const { container } = render(<ChatStream />);
    expect(container.querySelector('[data-testid="chat-thinking-dots"]')).toBeFalsy();
  });

  it('hides dots when not running (idle session with prior turns)', () => {
    seed({
      running: false,
      blocks: [{ kind: 'user', id: 'u1', text: 'hi' }]
    });
    const { container } = render(<ChatStream />);
    expect(container.querySelector('[data-testid="chat-thinking-dots"]')).toBeFalsy();
  });

  it('hides dots while a permission prompt is awaiting the user (different wait — for human, not for tokens)', () => {
    seed({
      running: true,
      blocks: [
        { kind: 'user', id: 'u1', text: 'run it' },
        {
          kind: 'waiting',
          id: 'w1',
          intent: 'permission',
          prompt: 'Allow Bash?',
          requestId: 'r-1',
          toolName: 'Bash'
        }
      ]
    });
    const { container } = render(<ChatStream />);
    expect(container.querySelector('[data-testid="chat-thinking-dots"]')).toBeFalsy();
  });
});
