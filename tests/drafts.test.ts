import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  hydrateDrafts,
  getDraft,
  setDraft,
  clearDraft,
  deleteDrafts,
  _resetForTests,
} from '../src/stores/drafts';

// v0.3 transitional: drafts.ts writes to localStorage directly
// (Wave 0e, #299) until SettingsService RPC ships. Mirror persist-shape
// test pattern from #289.
function installLocalStorage(initial?: string) {
  const store = new Map<string, string>();
  if (initial) store.set('drafts', initial);
  const getItem = vi.fn((k: string) => store.get(k) ?? null);
  const setItem = vi.fn((k: string, v: string) => {
    store.set(k, v);
  });
  (globalThis as unknown as { localStorage?: unknown }).localStorage = {
    getItem,
    setItem,
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    length: 0,
  };
  return { store, getItem, setItem };
}

beforeEach(() => {
  _resetForTests();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
});

async function flushPersist() {
  // Drain the 250ms debounce + the synchronous setItem call.
  await vi.advanceTimersByTimeAsync(300);
  await Promise.resolve();
}

describe('drafts persistence', () => {
  it('hydrates an empty cache when no blob exists', async () => {
    const { getItem } = installLocalStorage();
    await hydrateDrafts();
    expect(getItem).toHaveBeenCalledWith('drafts');
    expect(getDraft('s-1')).toBe('');
  });

  it('hydrates from a v1 blob', async () => {
    installLocalStorage(JSON.stringify({ version: 1, drafts: { 's-1': 'hello', 's-2': 'world' } }));
    await hydrateDrafts();
    expect(getDraft('s-1')).toBe('hello');
    expect(getDraft('s-2')).toBe('world');
  });

  it('ignores blobs with the wrong version', async () => {
    installLocalStorage(JSON.stringify({ version: 2, drafts: { 's-1': 'oops' } }));
    await hydrateDrafts();
    expect(getDraft('s-1')).toBe('');
  });

  it('survives corrupt JSON without throwing', async () => {
    installLocalStorage('{not json');
    await expect(hydrateDrafts()).resolves.not.toThrow();
    expect(getDraft('s-1')).toBe('');
  });

  it('writes via debounced setItem on setDraft', async () => {
    const { setItem } = installLocalStorage();
    await hydrateDrafts();
    setDraft('s-1', 'half-typed');
    expect(setItem).not.toHaveBeenCalled(); // debounced
    await flushPersist();
    expect(setItem).toHaveBeenCalledTimes(1);
    const [, blob] = setItem.mock.calls[0];
    expect(JSON.parse(blob as string)).toEqual({ version: 1, drafts: { 's-1': 'half-typed' } });
  });

  it('coalesces rapid edits into a single write', async () => {
    const { setItem } = installLocalStorage();
    await hydrateDrafts();
    setDraft('s-1', 'a');
    setDraft('s-1', 'ab');
    setDraft('s-1', 'abc');
    await flushPersist();
    expect(setItem).toHaveBeenCalledTimes(1);
    const [, blob] = setItem.mock.calls[0];
    expect(JSON.parse(blob as string).drafts['s-1']).toBe('abc');
  });

  it('clearDraft removes the entry and persists the deletion', async () => {
    const { setItem } = installLocalStorage(
      JSON.stringify({ version: 1, drafts: { 's-1': 'old' } })
    );
    await hydrateDrafts();
    expect(getDraft('s-1')).toBe('old');
    clearDraft('s-1');
    await flushPersist();
    expect(getDraft('s-1')).toBe('');
    const lastBlob = setItem.mock.calls.at(-1)?.[1] as string;
    expect(JSON.parse(lastBlob).drafts).toEqual({});
  });

  it('deleteDrafts batches removals and only writes when something changed', async () => {
    const { setItem } = installLocalStorage(
      JSON.stringify({ version: 1, drafts: { 's-1': 'a', 's-2': 'b' } })
    );
    await hydrateDrafts();
    deleteDrafts(['s-1', 's-3-never-existed']);
    await flushPersist();
    expect(setItem).toHaveBeenCalledTimes(1);
    const blob = JSON.parse(setItem.mock.calls.at(-1)?.[1] as string);
    expect(blob.drafts).toEqual({ 's-2': 'b' });
    setItem.mockClear();
    deleteDrafts(['s-already-gone']);
    await flushPersist();
    expect(setItem).not.toHaveBeenCalled();
  });

  it('preserves multiline / unicode / emoji content verbatim', async () => {
    const { setItem } = installLocalStorage();
    await hydrateDrafts();
    const tricky = 'line1\nline2 <tag> `code` 🚀\n\tindented';
    setDraft('s-1', tricky);
    await flushPersist();
    const blob = JSON.parse(setItem.mock.calls.at(-1)?.[1] as string);
    expect(blob.drafts['s-1']).toBe(tricky);
  });
});
