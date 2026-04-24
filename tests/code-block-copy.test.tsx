import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { CodeBlock } from '../src/components/CodeBlock';

const SAMPLE = "const x = 1;\nconsole.log(x);\n";

function setClipboard(impl: { writeText: (s: string) => Promise<void> }) {
  Object.defineProperty(navigator, 'clipboard', {
    value: impl,
    configurable: true,
    writable: true
  });
}

describe('<CodeBlock /> copy button', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the copy button with aria-label "Copy code"', () => {
    setClipboard({ writeText: vi.fn(async () => {}) });
    render(<CodeBlock code={SAMPLE} language="ts" />);
    const btn = screen.getByRole('button', { name: /copy code/i });
    expect(btn).toBeInTheDocument();
  });

  it('writes the trimmed code to the clipboard and shows the Copied state', async () => {
    const writeText = vi.fn(async () => {});
    setClipboard({ writeText });
    render(<CodeBlock code={SAMPLE} language="ts" />);

    const btn = screen.getByRole('button', { name: /copy code/i });
    await act(async () => {
      fireEvent.click(btn);
    });

    // Trailing newline is stripped before copy.
    expect(writeText).toHaveBeenCalledWith(SAMPLE.replace(/\n$/, ''));

    // After successful copy, the button switches to the "Copied" state and the
    // accessible label flips so screen-reader users hear the new state.
    expect(screen.getByRole('button', { name: /^copied$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^copied$/i })).toHaveAttribute('data-copied', 'true');
  });

  it('reverts the Copied state after ~1.5s', async () => {
    setClipboard({ writeText: vi.fn(async () => {}) });
    render(<CodeBlock code={SAMPLE} language="ts" />);

    const btn = screen.getByRole('button', { name: /copy code/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(screen.getByRole('button', { name: /^copied$/i })).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(1600);
    });

    expect(screen.getByRole('button', { name: /copy code/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^copied$/i })).not.toBeInTheDocument();
  });

  it('does not crash and does not flip to Copied when clipboard write rejects', async () => {
    const writeText = vi.fn(async () => {
      throw new Error('denied');
    });
    setClipboard({ writeText });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<CodeBlock code={SAMPLE} language="ts" />);

    const btn = screen.getByRole('button', { name: /copy code/i });
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(writeText).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /copy code/i })).toBeInTheDocument();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does not crash when navigator.clipboard is undefined', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      configurable: true,
      writable: true
    });
    render(<CodeBlock code={SAMPLE} language="ts" />);
    const btn = screen.getByRole('button', { name: /copy code/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    // Optional chaining means writeText is simply skipped → still in idle state.
    expect(screen.getByRole('button', { name: /copy code/i })).toBeInTheDocument();
  });
});
