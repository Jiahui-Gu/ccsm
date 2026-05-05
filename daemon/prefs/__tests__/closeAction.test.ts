import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the db module so we can drive loadState/saveState without a real
// SQLite file. The closeAction module under test imports these eagerly at
// module top.
const stateStore = new Map<string, string>();
vi.mock('../../db', () => ({
  loadState: (key: string) => (stateStore.has(key) ? stateStore.get(key)! : null),
  saveState: (key: string, value: string) => {
    stateStore.set(key, value);
  },
}));

import {
  parseCloseAction,
  getCloseAction,
  setCloseAction,
  CLOSE_ACTION_KEY,
} from '../closeAction';

beforeEach(() => {
  stateStore.clear();
});

describe('parseCloseAction', () => {
  it("returns 'ask' verbatim", () => {
    expect(parseCloseAction('ask', 'win32')).toBe('ask');
  });
  it("returns 'tray' verbatim", () => {
    expect(parseCloseAction('tray', 'linux')).toBe('tray');
  });
  it("returns 'quit' verbatim", () => {
    expect(parseCloseAction('quit', 'darwin')).toBe('quit');
  });
  it("falls back to 'tray' on darwin for missing/invalid input", () => {
    expect(parseCloseAction(null, 'darwin')).toBe('tray');
    expect(parseCloseAction(undefined, 'darwin')).toBe('tray');
    expect(parseCloseAction('', 'darwin')).toBe('tray');
    expect(parseCloseAction('garbage', 'darwin')).toBe('tray');
    expect(parseCloseAction(42, 'darwin')).toBe('tray');
  });
  it("falls back to 'ask' on win32 for missing/invalid input", () => {
    expect(parseCloseAction(null, 'win32')).toBe('ask');
    expect(parseCloseAction('garbage', 'win32')).toBe('ask');
  });
  it("falls back to 'ask' on linux for missing/invalid input", () => {
    expect(parseCloseAction(null, 'linux')).toBe('ask');
  });
});

describe('getCloseAction / setCloseAction roundtrip', () => {
  it('reads back the value written by setCloseAction', () => {
    setCloseAction('quit');
    expect(stateStore.get(CLOSE_ACTION_KEY)).toBe('quit');
    expect(getCloseAction()).toBe('quit');
  });
  it('round-trips tray', () => {
    setCloseAction('tray');
    expect(getCloseAction()).toBe('tray');
  });
  it('round-trips ask', () => {
    setCloseAction('ask');
    expect(getCloseAction()).toBe('ask');
  });
  it('returns the platform default when nothing was written', () => {
    // No setCloseAction call → falls through to parseCloseAction default.
    const expected = process.platform === 'darwin' ? 'tray' : 'ask';
    expect(getCloseAction()).toBe(expected);
  });
});
