// UT for src/components/ui/InlineRename.tsx — covers the documented contract
// of the inline editor used for session/group rename:
//   * mounts focused with the existing value selected
//   * onChange updates the draft
//   * Enter commits non-empty trimmed value via onCommit
//   * Enter on the same value (no-op) calls onCancel
//   * Enter on whitespace-only / empty calls onCancel
//   * Escape always cancels (bypasses arm gate)
//   * Tab commits and lets focus advance naturally
//   * IME composition swallows Enter commits during composing
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { InlineRename } from '../../src/components/ui/InlineRename';

afterEach(() => cleanup());

function setup(value = 'old name') {
  const onCommit = vi.fn(function (_v: string) {});
  const onCancel = vi.fn(function () {});
  const utils = render(
    <InlineRename value={value} onCommit={onCommit} onCancel={onCancel} />
  );
  const input = utils.container.querySelector('input')!;
  return { ...utils, input, onCommit, onCancel };
}

describe('<InlineRename />', () => {
  it('renders an <input> seeded with `value` and focused on mount', () => {
    const { input } = setup('hello');
    expect(input).toBeInstanceOf(HTMLInputElement);
    expect(input.value).toBe('hello');
    // Synchronous mount focus runs immediately
    expect(document.activeElement).toBe(input);
  });

  it('typing updates the input value (controlled draft state)', () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: 'new name' } });
    expect(input.value).toBe('new name');
  });

  it('Enter commits the trimmed draft via onCommit', () => {
    const { input, onCommit, onCancel } = setup();
    fireEvent.change(input, { target: { value: '  fresh title  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('fresh title');
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('Enter with the same trimmed value calls onCancel (no-op rename)', () => {
    const { input, onCommit, onCancel } = setup('same');
    fireEvent.change(input, { target: { value: 'same' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('Enter with empty/whitespace-only draft calls onCancel', () => {
    const { input, onCommit, onCancel } = setup('original');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('Escape always calls onCancel (bypasses arm gate)', () => {
    const { input, onCommit, onCancel } = setup();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('Tab commits the change without preventing default focus advance', () => {
    const { input, onCommit } = setup();
    fireEvent.change(input, { target: { value: 'tabbed' } });
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(onCommit).toHaveBeenCalledWith('tabbed');
  });

  it('Enter during IME composition is swallowed (CJK candidate selection)', () => {
    const { input, onCommit, onCancel } = setup();
    fireEvent.change(input, { target: { value: 'mid' } });
    // Vitest jsdom: nativeEvent.isComposing on a synthetic Enter event.
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('compositionStart sets the composing guard so subsequent commit() is a no-op', () => {
    const { input, onCommit, onCancel } = setup();
    fireEvent.change(input, { target: { value: 'piny' } });
    fireEvent.compositionStart(input);
    // Even if Enter slips past the keydown filter, commit() short-circuits
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('piny');
  });

  it('respects maxLength prop on the rendered input', () => {
    const onCommit = vi.fn(function (_v: string) {});
    const onCancel = vi.fn(function () {});
    const { container } = render(
      <InlineRename value="x" onCommit={onCommit} onCancel={onCancel} maxLength={20} />
    );
    expect(container.querySelector('input')!.getAttribute('maxlength')).toBe('20');
  });

  it('forwards placeholder', () => {
    const onCommit = vi.fn(function (_v: string) {});
    const onCancel = vi.fn(function () {});
    const { container } = render(
      <InlineRename
        value=""
        onCommit={onCommit}
        onCancel={onCancel}
        placeholder="Name…"
      />
    );
    expect(container.querySelector('input')!.getAttribute('placeholder')).toBe('Name…');
  });
});
