import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { QuestionBlock } from '../src/components/QuestionBlock';
import type { QuestionSpec } from '../src/types';

// Lets the rAF that schedules option auto-focus run, plus the 300ms
// auto-advance timer when single-select picks fire.
async function flushTimers(ms = 350) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

const SINGLE: QuestionSpec[] = [
  {
    question: 'Which language?',
    header: 'Language',
    options: [{ label: 'Python' }, { label: 'TypeScript' }, { label: 'Rust' }]
  }
];

const MULTI: QuestionSpec[] = [
  {
    question: 'Which tools?',
    header: 'Tools',
    multiSelect: true,
    options: [{ label: 'ESLint' }, { label: 'Prettier' }, { label: 'Vitest' }]
  }
];

const TRIPLE: QuestionSpec[] = [
  {
    question: 'Q1?',
    header: 'One',
    options: [{ label: 'A' }, { label: 'B' }]
  },
  {
    question: 'Q2?',
    header: 'Two',
    options: [{ label: 'X' }, { label: 'Y' }]
  },
  {
    question: 'Q3?',
    header: 'Three',
    multiSelect: true,
    options: [{ label: 'Cat' }, { label: 'Dog' }]
  }
];

describe('<QuestionBlock /> upstream parity', () => {
  it('always appends an Other option to every question', async () => {
    render(<QuestionBlock questions={SINGLE} onSubmit={() => {}} />);
    await flushTimers(50);
    const opts = screen.getAllByRole('radio');
    // 3 model options + Other.
    expect(opts).toHaveLength(4);
    expect(opts[3].dataset.questionLabel).toBe('Other');
  });

  it('Submit is disabled until every question has a selection (multi-question)', async () => {
    const onSubmit = vi.fn();
    render(<QuestionBlock questions={TRIPLE} onSubmit={onSubmit} />);
    await flushTimers(50);
    expect(screen.getByTestId('question-submit')).toBeDisabled();
  });

  it('single-select auto-advances to next question after a 300ms confirm', async () => {
    render(<QuestionBlock questions={TRIPLE} onSubmit={() => {}} />);
    await flushTimers(50);
    expect(screen.getByTestId('question-tab-0').dataset.active).toBe('true');
    fireEvent.click(screen.getAllByRole('radio')[0]);
    await flushTimers(350);
    expect(screen.getByTestId('question-tab-1').dataset.active).toBe('true');
  });

  it('does NOT auto-advance on the last question', async () => {
    render(<QuestionBlock questions={TRIPLE} onSubmit={() => {}} />);
    await flushTimers(50);
    fireEvent.click(screen.getByTestId('question-tab-2'));
    await flushTimers(50);
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    await flushTimers(400);
    expect(screen.getByTestId('question-tab-2').dataset.active).toBe('true');
  });

  it('multi-select toggles options and never auto-advances', async () => {
    render(<QuestionBlock questions={MULTI} onSubmit={() => {}} />);
    await flushTimers(50);
    const boxes = screen.getAllByRole('checkbox');
    fireEvent.click(boxes[0]);
    fireEvent.click(boxes[1]);
    expect(boxes[0].getAttribute('aria-checked')).toBe('true');
    expect(boxes[1].getAttribute('aria-checked')).toBe('true');
  });

  it('left/right arrow keys page between questions and preserve answers', async () => {
    render(<QuestionBlock questions={TRIPLE} onSubmit={() => {}} />);
    await flushTimers(50);
    fireEvent.click(screen.getByTestId('question-tab-1'));
    await flushTimers(50);
    fireEvent.click(screen.getAllByRole('radio')[1]); // pick Y on Q2
    await flushTimers(350);
    const root = screen.getByRole('dialog');
    fireEvent.keyDown(root, { key: 'ArrowLeft' });
    fireEvent.keyDown(root, { key: 'ArrowLeft' });
    expect(screen.getByTestId('question-tab-0').dataset.active).toBe('true');
    fireEvent.keyDown(root, { key: 'ArrowRight' });
    expect(screen.getByTestId('question-tab-1').dataset.active).toBe('true');
    const radios = screen.getAllByRole('radio');
    expect(radios[1].getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('question-tab-1').dataset.answered).toBe('true');
  });

  it('Other selection expands an inline input; submit replaces label with the typed text', async () => {
    const onSubmit = vi.fn();
    render(<QuestionBlock questions={SINGLE} onSubmit={onSubmit} />);
    await flushTimers(50);
    const opts = screen.getAllByRole('radio');
    fireEvent.click(opts[3]);
    await flushTimers(20);
    const input = screen.getByTestId('question-other-input');
    input.textContent = 'Haskell, Lisp';
    fireEvent.input(input);
    fireEvent.click(screen.getByTestId('question-submit'));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0][0] as Record<string, string>;
    expect(payload['Which language?']).toBe('Haskell, Lisp');
  });

  it('multi-select payload joins labels with "\\n " (matches upstream)', async () => {
    const onSubmit = vi.fn();
    render(<QuestionBlock questions={MULTI} onSubmit={onSubmit} />);
    await flushTimers(50);
    const boxes = screen.getAllByRole('checkbox');
    fireEvent.click(boxes[0]);
    fireEvent.click(boxes[2]);
    fireEvent.click(screen.getByTestId('question-submit'));
    const payload = onSubmit.mock.calls[0][0] as Record<string, string>;
    expect(payload['Which tools?']).toBe('ESLint\n Vitest');
  });

  it('Esc invokes onReject and does NOT submit', async () => {
    const onSubmit = vi.fn();
    const onReject = vi.fn();
    render(<QuestionBlock questions={SINGLE} onSubmit={onSubmit} onReject={onReject} />);
    await flushTimers(50);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('chip tabs reflect per-question answered state', async () => {
    render(<QuestionBlock questions={TRIPLE} onSubmit={() => {}} />);
    await flushTimers(50);
    expect(screen.getByTestId('question-tab-0').dataset.answered).toBe('false');
    fireEvent.click(screen.getAllByRole('radio')[0]);
    await flushTimers(350);
    expect(screen.getByTestId('question-tab-0').dataset.answered).toBe('true');
  });

  it('renders nothing if questions is empty', () => {
    const { container } = render(<QuestionBlock questions={[]} onSubmit={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('options expose role=radio (single) or role=checkbox (multi)', async () => {
    const { rerender } = render(<QuestionBlock questions={SINGLE} onSubmit={() => {}} />);
    await flushTimers(50);
    expect(screen.getAllByRole('radio').length).toBeGreaterThan(0);
    rerender(<QuestionBlock questions={MULTI} onSubmit={() => {}} />);
    await flushTimers(50);
    expect(screen.getAllByRole('checkbox').length).toBeGreaterThan(0);
  });

  it('navbar exposes a chip per question with the header label', async () => {
    render(<QuestionBlock questions={TRIPLE} onSubmit={() => {}} />);
    await flushTimers(50);
    const nav = screen.getByTestId('question-nav-bar');
    expect(within(nav).getByText('One')).toBeTruthy();
    expect(within(nav).getByText('Two')).toBeTruthy();
    expect(within(nav).getByText('Three')).toBeTruthy();
  });
});
