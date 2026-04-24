// Per-file collapse toggle for DiffView (#302).
//
// Asserts the structural defaults required by the spec:
//   - <=3 files → all sections expanded on first paint
//   - >3 files → all sections collapsed on first paint
//   - Toggling one chevron only affects that file's section
//   - Single-file case still renders hunks (existing behavior preserved)
//
// We probe by file-section button[aria-expanded] on a stable
// data-testid="diff-view" wrapper to avoid coupling to Tailwind class strings.
import React from 'react';
import { describe, it, expect, beforeAll } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { DiffView } from '../src/components/chat/DiffView';
import type { DiffSpec } from '../src/utils/diff';
import { initI18n } from '../src/i18n';

beforeAll(() => initI18n('en'));

function spec(file: string, removed: string[], added: string[]): DiffSpec {
  return { filePath: file, hunks: [{ removed, added }] };
}

function fileButtons(): HTMLButtonElement[] {
  const root = screen.getByTestId('diff-view');
  return Array.from(
    within(root).getAllByRole('button', { name: /toggle file:/i })
  ) as HTMLButtonElement[];
}

describe('<DiffView /> per-file collapse', () => {
  it('multi-file (5) defaults all collapsed; clicking one expands only that file', () => {
    const five: DiffSpec[] = [
      spec('/a/one.ts', ['a'], ['A_TOK_ONE']),
      spec('/a/two.ts', ['b'], ['A_TOK_TWO']),
      spec('/a/three.ts', ['c'], ['A_TOK_THREE']),
      spec('/a/four.ts', ['d'], ['A_TOK_FOUR']),
      spec('/a/five.ts', ['e'], ['A_TOK_FIVE'])
    ];
    render(<DiffView diff={five} />);

    const btns = fileButtons();
    expect(btns).toHaveLength(5);
    // First paint: every section collapsed (5 > threshold of 3).
    for (const b of btns) expect(b.getAttribute('aria-expanded')).toBe('false');
    // Body content for any file should be hidden because all collapsed.
    for (const tok of ['A_TOK_ONE', 'A_TOK_TWO', 'A_TOK_THREE', 'A_TOK_FOUR', 'A_TOK_FIVE']) {
      expect(screen.queryByText(tok)).toBeNull();
    }

    // Click the first chevron: that file expands, others stay collapsed.
    fireEvent.click(btns[0]);
    const after = fileButtons();
    expect(after[0].getAttribute('aria-expanded')).toBe('true');
    for (let i = 1; i < after.length; i++) {
      expect(after[i].getAttribute('aria-expanded')).toBe('false');
    }
    expect(screen.queryByText('A_TOK_ONE')).not.toBeNull();
    for (const tok of ['A_TOK_TWO', 'A_TOK_THREE', 'A_TOK_FOUR', 'A_TOK_FIVE']) {
      expect(screen.queryByText(tok)).toBeNull();
    }
  });

  it('multi-file (2) defaults all expanded — under the threshold', () => {
    const two: DiffSpec[] = [
      spec('/a/x.ts', [], ['EXPAND_TOK_X']),
      spec('/a/y.ts', [], ['EXPAND_TOK_Y'])
    ];
    render(<DiffView diff={two} />);
    const btns = fileButtons();
    expect(btns).toHaveLength(2);
    for (const b of btns) expect(b.getAttribute('aria-expanded')).toBe('true');
    expect(screen.queryByText('EXPAND_TOK_X')).not.toBeNull();
    expect(screen.queryByText('EXPAND_TOK_Y')).not.toBeNull();
  });

  it('single-file (legacy DiffSpec) preserves the hunk + Accept/Reject controls', () => {
    const one = spec('/a/single.ts', ['old'], ['SINGLE_TOK']);
    render(<DiffView diff={one} />);
    // Section button is present and starts expanded (1 <= 3).
    const btns = fileButtons();
    expect(btns).toHaveLength(1);
    expect(btns[0].getAttribute('aria-expanded')).toBe('true');
    // Hunk content + Accept/Reject buttons still wired up.
    expect(screen.queryByText('SINGLE_TOK')).not.toBeNull();
    expect(screen.getByRole('button', { name: /^accept$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^reject$/i })).toBeInTheDocument();
  });

  it('renders +N/-M counts in the header chip', () => {
    const s = spec('/a/counts.ts', ['r1', 'r2', 'r3'], ['a1', 'a2']);
    render(<DiffView diff={[s]} />);
    const root = screen.getByTestId('diff-view');
    expect(within(root).getByText('+2')).toBeInTheDocument();
    expect(within(root).getByText('-3')).toBeInTheDocument();
  });
});
