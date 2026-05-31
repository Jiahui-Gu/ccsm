// src/mobile/__tests__/mobilePage.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createXtermPhoneUi } from '../mobilePage';

/** Minimal xterm Terminal fake: records writes/resets. */
function fakeTerminal() {
  return {
    write: vi.fn(),
    reset: vi.fn(),
    writes: [] as string[],
  };
}

describe('createXtermPhoneUi', () => {
  it('write() forwards the chunk to the terminal', () => {
    const term = fakeTerminal();
    const ui = createXtermPhoneUi({
      terminal: term as never,
      sessionListEl: { replaceChildren: vi.fn() } as never,
      statusEl: { textContent: '' } as never,
      makeChip: () => ({}) as never,
    });
    ui.write('hello');
    expect(term.write).toHaveBeenCalledWith('hello');
  });

  it('reset() clears the terminal', () => {
    const term = fakeTerminal();
    const ui = createXtermPhoneUi({
      terminal: term as never,
      sessionListEl: { replaceChildren: vi.fn() } as never,
      statusEl: { textContent: '' } as never,
      makeChip: () => ({}) as never,
    });
    ui.reset();
    expect(term.reset).toHaveBeenCalled();
  });

  it('setStatus() writes the status text into the status element', () => {
    const term = fakeTerminal();
    const statusEl = { textContent: '' };
    const ui = createXtermPhoneUi({
      terminal: term as never,
      sessionListEl: { replaceChildren: vi.fn() } as never,
      statusEl: statusEl as never,
      makeChip: () => ({}) as never,
    });
    ui.setStatus('connected');
    expect(statusEl.textContent).toBe('connected');
  });

  it('renderSessions() builds one chip per session via makeChip and mounts them', () => {
    const term = fakeTerminal();
    const replaceChildren = vi.fn();
    const makeChip = vi.fn((sid: string) => ({ sid }) as never);
    const ui = createXtermPhoneUi({
      terminal: term as never,
      sessionListEl: { replaceChildren } as never,
      statusEl: { textContent: '' } as never,
      makeChip,
    });
    ui.renderSessions(
      [{ sid: 'a', cwd: '/x', cols: 80, rows: 24 }, { sid: 'b', cwd: '/y', cols: 80, rows: 24 }],
      'a',
    );
    expect(makeChip).toHaveBeenCalledTimes(2);
    expect(replaceChildren).toHaveBeenCalled();
  });
});
