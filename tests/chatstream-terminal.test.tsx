import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock xterm (jsdom can't render it) so we can verify ChatStream routes
// Bash tool results into Terminal and non-Bash into the plain <pre>.
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
  unobserve(): void {}
  disconnect(): void {}
}
beforeEach(() => {
  (globalThis as unknown as { ResizeObserver: typeof StubResizeObserver }).ResizeObserver =
    StubResizeObserver;
});
afterEach(() => {
  // Don't call vi.restoreAllMocks() — it clears mockImplementation on the
  // constructors inside vi.mock factories, so subsequent `new Terminal()` /
  // `new FitAddon()` return undefined and break mounts.
});

import { render, cleanup, fireEvent } from '@testing-library/react';
import { ChatStream } from '../src/components/ChatStream';
import { useStore } from '../src/stores/store';
import type { MessageBlock } from '../src/types';

const initial = useStore.getState();

afterEach(() => cleanup());

function seed(blocks: MessageBlock[]) {
  useStore.setState(
    {
      ...initial,
      activeId: 's1',
      messagesBySession: { s1: blocks }
    },
    true
  );
}

describe('ChatStream tool rendering', () => {
  it('renders Terminal (xterm host) for Bash tool output', () => {
    seed([
      {
        kind: 'tool',
        id: 't1',
        name: 'Bash',
        brief: 'ls -la',
        expanded: false,
        toolUseId: 'tu-1',
        input: { command: 'ls -la' },
        result: 'total 0\n\u001b[34mdir\u001b[0m file\n'
      }
    ]);
    const { getByRole, container } = render(<ChatStream />);
    // Expand the tool row.
    const btn = getByRole('button', { name: /Bash/ });
    fireEvent.click(btn);
    expect(container.querySelector('[data-testid="terminal-host"]')).toBeTruthy();
  });

  it('renders a plain <pre> for non-shell tools (e.g. Read)', () => {
    seed([
      {
        kind: 'tool',
        id: 't2',
        name: 'Read',
        brief: 'foo.ts',
        expanded: false,
        toolUseId: 'tu-2',
        input: { file_path: '/x/foo.ts' },
        result: 'contents of foo.ts'
      }
    ]);
    const { getByRole, container, getByText } = render(<ChatStream />);
    const btn = getByRole('button', { name: /Read/ });
    fireEvent.click(btn);
    expect(container.querySelector('[data-testid="terminal-host"]')).toBeFalsy();
    expect(getByText('contents of foo.ts')).toBeInTheDocument();
  });
});
