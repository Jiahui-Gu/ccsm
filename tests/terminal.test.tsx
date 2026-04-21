import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock xterm (canvas APIs absent in jsdom). We don't assert on call spies
// per-test — instead we verify DOM contracts (host mount, empty-state hints,
// dispose-on-unmount via mount/unmount being non-throwing). Per-instance
// spying on xterm methods inside vi.mock factory is flaky across vitest
// hoisting semantics — simpler to assert observable outputs.
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
  (window as unknown as { ResizeObserver: typeof StubResizeObserver }).ResizeObserver =
    StubResizeObserver;
});

afterEach(() => {
  // Note: do NOT call vi.restoreAllMocks() here — it would clear the
  // mockImplementation on the constructor fns inside the vi.mock factories,
  // which causes subsequent `new Terminal()` calls to return undefined and
  // break the component mount.
});

import { render, cleanup } from '@testing-library/react';
import { Terminal } from '../src/components/Terminal';

afterEach(() => cleanup());

describe('Terminal', () => {
  it('mounts a host element for xterm to attach to', () => {
    const { container } = render(<Terminal data={'hello\nworld'} />);
    expect(container.querySelector('[data-testid="terminal-host"]')).toBeTruthy();
  });

  it('accepts data prop updates without throwing (grow / shrink / diverge)', () => {
    const { rerender } = render(<Terminal data="abc" />);
    rerender(<Terminal data="abcdef" />); // grow → append tail
    rerender(<Terminal data="xyz" />);    // diverge → reset + rewrite
    rerender(<Terminal data="" />);       // shrink to empty
  });

  it('shows a running hint when empty and running', () => {
    const { getByText } = render(<Terminal data="" running />);
    expect(getByText('waiting for output…')).toBeInTheDocument();
  });

  it('shows a no-output hint when empty and not running', () => {
    const { getByText } = render(<Terminal data="" />);
    expect(getByText('(no output)')).toBeInTheDocument();
  });

  it('hides hints once data arrives', () => {
    const { queryByText } = render(<Terminal data="ok" running />);
    expect(queryByText('waiting for output…')).toBeNull();
    expect(queryByText('(no output)')).toBeNull();
  });

  it('mounts and unmounts cleanly', () => {
    const { unmount } = render(<Terminal data="x" />);
    expect(() => unmount()).not.toThrow();
  });
});
