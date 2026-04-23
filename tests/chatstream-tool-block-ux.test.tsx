// Covers three related tool-block UX signals (bundled backlog items):
//   A2-NEW-5  elapsed-time counter while a tool is in-flight
//   A2-NEW-6  "(no result)" marker for dropped / empty tool results
//   A2-NEW-7  "(taking longer than usual…)" stall hint after 30s
//
// The happy-path elapsed-time render while a Bash tool is actually running
// is exercised in the Playwright harness case `tool-block-ux`
// (scripts/harness-agent.mjs). This file uses RTL to cover the paths that
// are painful to reproduce against a live CLI: an explicit empty result
// (dropped tool) and a still-waiting block whose startedAt is far enough
// in the past that the stall-hint threshold has been crossed.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ChatStream pulls Terminal at module-eval, so the xterm shims have to be
// installed before importing it. Copied verbatim from
// chatstream-thinking-dots.test.tsx / chatstream-terminal.test.tsx.
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

import { render, cleanup, act } from '@testing-library/react';
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
      messagesBySession: { s1: blocks },
      runningSessions: { s1: true }
    },
    true
  );
}

describe('ToolBlock UX triad', () => {
  // A2-NEW-5: counter renders while tool is in-flight and disappears once
  // the result lands. We don't try to assert the exact value (React-DOM
  // + jsdom + our 100ms interval is flaky on tick timing) — presence /
  // absence is the load-bearing bit; the harness case asserts the format.
  it('renders an elapsed-time counter while a tool is still running', () => {
    seed([
      { kind: 'user', id: 'u1', text: 'please run ls' },
      {
        kind: 'tool',
        id: 't1',
        name: 'Bash',
        brief: 'ls -la',
        expanded: false,
        toolUseId: 'tu1'
        // no `result` -> in-flight
      }
    ]);
    const { container } = render(<ChatStream />);
    const elapsed = container.querySelector('[data-testid="tool-elapsed"]');
    expect(elapsed).toBeTruthy();
    // Text must match the documented `<num>.<num>s` pattern so the harness
    // regex and the component format stay aligned.
    expect(elapsed?.textContent ?? '').toMatch(/^\d+\.\ds$/);
  });

  it('does NOT render the counter once result has landed', () => {
    seed([
      {
        kind: 'tool',
        id: 't1',
        name: 'Bash',
        brief: 'ls -la',
        expanded: false,
        toolUseId: 'tu1',
        result: 'file1\nfile2\n'
      }
    ]);
    const { container } = render(<ChatStream />);
    expect(container.querySelector('[data-testid="tool-elapsed"]')).toBeFalsy();
  });

  // A2-NEW-6: when the tool result was explicitly empty ("" — the signal
  // the dropped-tool path historically surfaced), the block should carry
  // a muted "(no result)" marker so it isn't silent empty space.
  it('renders "(no result)" when the tool result is an empty string (dropped)', () => {
    seed([
      {
        kind: 'tool',
        id: 't1',
        name: 'Read',
        brief: 'src/foo.ts',
        expanded: false,
        toolUseId: 'tu1',
        result: ''
      }
    ]);
    const { container } = render(<ChatStream />);
    const marker = container.querySelector('[data-testid="tool-no-result"]');
    expect(marker).toBeTruthy();
    expect(marker?.textContent).toContain('no result');
  });

  it('renders "(no result)" when brief is empty but result did land', () => {
    seed([
      {
        kind: 'tool',
        id: 't1',
        name: 'Read',
        brief: '',
        expanded: false,
        toolUseId: 'tu1',
        result: 'something'
      }
    ]);
    const { container } = render(<ChatStream />);
    expect(container.querySelector('[data-testid="tool-no-result"]')).toBeTruthy();
  });

  it('does NOT render "(no result)" for a healthy completed tool block', () => {
    seed([
      {
        kind: 'tool',
        id: 't1',
        name: 'Read',
        brief: 'src/foo.ts',
        expanded: false,
        toolUseId: 'tu1',
        result: 'hello\n'
      }
    ]);
    const { container } = render(<ChatStream />);
    expect(container.querySelector('[data-testid="tool-no-result"]')).toBeFalsy();
  });

  // A2-NEW-7: stall hint. We drive `Date.now` forward with fake timers
  // past the 30s threshold so the next interval tick flips the flag.
  it('renders "(taking longer)" hint after 30s on a still-running tool', async () => {
    const base = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(base);
    try {
      seed([
        {
          kind: 'tool',
          id: 't1',
          name: 'Bash',
          brief: 'sleep 60',
          expanded: false,
          toolUseId: 'tu1'
        }
      ]);
      const { container } = render(<ChatStream />);
      // Before 30s: no stall hint.
      expect(container.querySelector('[data-testid="tool-stalled"]')).toBeFalsy();

      // Jump 35s and let one interval tick + re-render land.
      await act(async () => {
        vi.setSystemTime(base + 35_000);
        vi.advanceTimersByTime(200);
      });

      const stalled = container.querySelector('[data-testid="tool-stalled"]');
      expect(stalled).toBeTruthy();
      expect(stalled?.textContent ?? '').toMatch(/taking longer/i);
    } finally {
      vi.useRealTimers();
    }
  });
});
