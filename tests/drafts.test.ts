import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  hydrateDrafts,
  getDraft,
  setDraft,
  clearDraft,
  deleteDrafts,
  _resetForTests,
} from '../src/stores/drafts';

// Minimal fake of the IPC surface the drafts module touches: just
// loadState/saveState scoped to a single in-memory blob.
function installAgentory(initial?: string) {
  const store = new Map<string, string>();
  if (initial) store.set('drafts', initial);
  const loadState = vi.fn(async (k: string) => store.get(k) ?? null);
  const saveState = vi.fn(async (k: string, v: string) => {
    store.set(k, v);
  });
  // Cast through unknown — we're only exercising the two methods drafts.ts uses.
  (window as unknown as { agentory: unknown }).agentory = { loadState, saveState };
  return { store, loadState, saveState };
}

beforeEach(() => {
  _resetForTests();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  delete (window as unknown as { agentory?: unknown }).agentory;
});

async function flushPersist() {
  // Drain the 250ms debounce + the awaited saveState promise.
  await vi.advanceTimersByTimeAsync(300);
  await Promise.resolve();
}

describe('drafts persistence', () => {
  it('hydrates an empty cache when no blob exists', async () => {
    const { loadState } = installAgentory();
    await hydrateDrafts();
    expect(loadState).toHaveBeenCalledWith('drafts');
    expect(getDraft('s-1')).toBe('');
  });

  it('hydrates from a v1 blob', async () => {
    installAgentory(JSON.stringify({ version: 1, drafts: { 's-1': 'hello', 's-2': 'world' } }));
    await hydrateDrafts();
    expect(getDraft('s-1')).toBe('hello');
    expect(getDraft('s-2')).toBe('world');
  });

  it('ignores blobs with the wrong version', async () => {
    installAgentory(JSON.stringify({ version: 2, drafts: { 's-1': 'oops' } }));
    await hydrateDrafts();
    expect(getDraft('s-1')).toBe('');
  });

  it('survives corrupt JSON without throwing', async () => {
    installAgentory('{not json');
    await expect(hydrateDrafts()).resolves.not.toThrow();
    expect(getDraft('s-1')).toBe('');
  });

  it('writes via debounced saveState on setDraft', async () => {
    const { saveState } = installAgentory();
    await hydrateDrafts();
    setDraft('s-1', 'half-typed');
    expect(saveState).not.toHaveBeenCalled(); // debounced
    await flushPersist();
    expect(saveState).toHaveBeenCalledTimes(1);
    const [, blob] = saveState.mock.calls[0];
    expect(JSON.parse(blob as string)).toEqual({ version: 1, drafts: { 's-1': 'half-typed' } });
  });

  it('coalesces rapid edits into a single write', async () => {
    const { saveState } = installAgentory();
    await hydrateDrafts();
    setDraft('s-1', 'a');
    setDraft('s-1', 'ab');
    setDraft('s-1', 'abc');
    await flushPersist();
    expect(saveState).toHaveBeenCalledTimes(1);
    const [, blob] = saveState.mock.calls[0];
    expect(JSON.parse(blob as string).drafts['s-1']).toBe('abc');
  });

  it('clearDraft removes the entry and persists the deletion', async () => {
    const { saveState } = installAgentory(
      JSON.stringify({ version: 1, drafts: { 's-1': 'old' } })
    );
    await hydrateDrafts();
    expect(getDraft('s-1')).toBe('old');
    clearDraft('s-1');
    await flushPersist();
    expect(getDraft('s-1')).toBe('');
    const lastBlob = saveState.mock.calls.at(-1)?.[1] as string;
    expect(JSON.parse(lastBlob).drafts).toEqual({});
  });

  it('deleteDrafts batches removals and only writes when something changed', async () => {
    const { saveState } = installAgentory(
      JSON.stringify({ version: 1, drafts: { 's-1': 'a', 's-2': 'b' } })
    );
    await hydrateDrafts();
    deleteDrafts(['s-1', 's-3-never-existed']);
    await flushPersist();
    expect(saveState).toHaveBeenCalledTimes(1);
    const blob = JSON.parse(saveState.mock.calls.at(-1)?.[1] as string);
    expect(blob.drafts).toEqual({ 's-2': 'b' });
    saveState.mockClear();
    deleteDrafts(['s-already-gone']);
    await flushPersist();
    expect(saveState).not.toHaveBeenCalled();
  });

  it('preserves multiline / unicode / emoji content verbatim', async () => {
    const { saveState } = installAgentory();
    await hydrateDrafts();
    const tricky = 'line1\nline2 <tag> `code` 🚀\n\tindented';
    setDraft('s-1', tricky);
    await flushPersist();
    const blob = JSON.parse(saveState.mock.calls.at(-1)?.[1] as string);
    expect(blob.drafts['s-1']).toBe(tricky);
  });
});
