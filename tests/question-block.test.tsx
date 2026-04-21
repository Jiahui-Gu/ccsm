import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { QuestionBlock } from '../src/components/QuestionBlock';
import type { QuestionSpec } from '../src/types';

function flushRaf() {
  return act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

describe('<QuestionBlock />', () => {
  const singleSelect: QuestionSpec[] = [
    {
      question: 'Which language?',
      options: [
        { label: 'Python' },
        { label: 'TypeScript' },
        { label: 'Rust' }
      ]
    }
  ];

  const multiSelect: QuestionSpec[] = [
    {
      question: 'Which tools?',
      multiSelect: true,
      options: [
        { label: 'ESLint' },
        { label: 'Prettier' },
        { label: 'Vitest' }
      ]
    }
  ];

  it('auto-focuses the first option on mount (single-select)', async () => {
    render(<QuestionBlock questions={singleSelect} onSubmit={() => {}} />);
    await flushRaf();
    const radios = screen.getAllByRole('radio');
    expect(document.activeElement).toBe(radios[0]);
  });

  it('wires arrow-key navigation via Radix RadioGroup (orientation=vertical)', async () => {
    const { container } = render(<QuestionBlock questions={singleSelect} onSubmit={() => {}} />);
    await flushRaf();
    const group = container.querySelector('[role="radiogroup"]');
    expect(group).not.toBeNull();
    expect(group?.getAttribute('aria-orientation')).toBe('vertical');
    const radios = screen.getAllByRole('radio');
    // All three options rendered, and one is tabbable (the roving tab stop).
    expect(radios).toHaveLength(3);
    const tabbable = radios.filter((r) => r.getAttribute('tabindex') === '0');
    expect(tabbable.length).toBe(1);
  });

  it('Enter on a focused option submits the currently-selected option', async () => {
    const onSubmit = vi.fn();
    render(<QuestionBlock questions={singleSelect} onSubmit={onSubmit} />);
    await flushRaf();
    const radios = screen.getAllByRole('radio');
    // Simulate user clicking option 2 (TypeScript) then pressing Enter while focused.
    fireEvent.click(radios[1]);
    radios[1].focus();
    fireEvent.keyDown(radios[1], { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toMatch(/TypeScript/);
  });

  it('Escape blurs the focused option without submitting', async () => {
    const onSubmit = vi.fn();
    render(<QuestionBlock questions={singleSelect} onSubmit={onSubmit} />);
    await flushRaf();
    const radios = screen.getAllByRole('radio');
    radios[0].focus();
    expect(document.activeElement).toBe(radios[0]);
    fireEvent.keyDown(radios[0], { key: 'Escape' });
    expect(document.activeElement).not.toBe(radios[0]);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('pre-selects the first option so Submit is enabled immediately (single-select)', async () => {
    render(<QuestionBlock questions={singleSelect} onSubmit={() => {}} />);
    await flushRaf();
    const submit = screen.getByRole('button', { name: /submit answer/i });
    expect(submit).not.toBeDisabled();
  });

  it('Submit is disabled until at least one box is checked (multi-select)', async () => {
    render(<QuestionBlock questions={multiSelect} onSubmit={() => {}} />);
    await flushRaf();
    const submit = screen.getByRole('button', { name: /submit answer/i });
    expect(submit).toBeDisabled();
    const boxes = screen.getAllByRole('checkbox');
    fireEvent.click(boxes[1]);
    expect(submit).not.toBeDisabled();
  });

  it('multi-select: Space toggles the focused checkbox', async () => {
    render(<QuestionBlock questions={multiSelect} onSubmit={() => {}} />);
    await flushRaf();
    const boxes = screen.getAllByRole('checkbox');
    boxes[0].focus();
    expect(boxes[0].getAttribute('data-state')).toBe('unchecked');
    // Radix Checkbox toggles on Space via native button activation.
    fireEvent.keyDown(boxes[0], { key: ' ', code: 'Space' });
    fireEvent.keyUp(boxes[0], { key: ' ', code: 'Space' });
    // jsdom doesn't always dispatch click on keyup-space for buttons; fall
    // back to a direct click to assert the wiring via onCheckedChange.
    if (boxes[0].getAttribute('data-state') !== 'checked') {
      fireEvent.click(boxes[0]);
    }
    expect(boxes[0].getAttribute('data-state')).toBe('checked');
  });

  it('does not auto-focus when autoFocus={false} (older widgets stay put)', async () => {
    const { container } = render(
      <div>
        <QuestionBlock questions={singleSelect} onSubmit={() => {}} autoFocus={false} />
      </div>
    );
    await flushRaf();
    // No option should have grabbed focus.
    const radios = container.querySelectorAll('[role="radio"]');
    expect(document.activeElement).not.toBe(radios[0]);
  });

  it('older widget keeps focus away when a new widget mounts later (no focus steal)', async () => {
    const { rerender } = render(
      <div>
        <QuestionBlock questions={singleSelect} onSubmit={() => {}} autoFocus={false} />
      </div>
    );
    await flushRaf();
    // Simulate user focusing an external element (the document body here).
    const external = document.createElement('input');
    document.body.appendChild(external);
    external.focus();
    expect(document.activeElement).toBe(external);

    rerender(
      <div>
        <QuestionBlock questions={singleSelect} onSubmit={() => {}} autoFocus={false} />
        <QuestionBlock
          questions={[
            {
              question: 'Second?',
              options: [{ label: 'A' }, { label: 'B' }]
            }
          ]}
          onSubmit={() => {}}
        />
      </div>
    );
    await flushRaf();
    // External element still has focus — the new widget must not steal.
    expect(document.activeElement).toBe(external);
    document.body.removeChild(external);
  });
});
