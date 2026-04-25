import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../src/stores/store';

// Snapshot/restore initial state for isolation. The store auto-subscribes
// to persist via hydrateStore(); we never call it in tests, so all set()
// calls are purely in-memory.
const initial = useStore.getState();

beforeEach(() => {
  useStore.setState({ ...initial, pendingDiffComments: {} }, true);
});

describe('store: addDiffComment dedupe', () => {
  const sid = 's-1';
  const file = 'src/foo.ts';
  const line = 42;

  it('replaces an existing (file, line) comment instead of stacking', () => {
    const id1 = useStore.getState().addDiffComment(sid, { file, line, text: 'first' });
    const id2 = useStore.getState().addDiffComment(sid, { file, line, text: 'second' });

    const bucket = useStore.getState().pendingDiffComments[sid] ?? {};
    const list = Object.values(bucket);

    expect(list).toHaveLength(1);
    expect(list[0].text).toBe('second');
    // Reusing the id keeps DiffView's data-diff-comment-id DOM lookups stable.
    expect(id2).toBe(id1);
    expect(bucket[id1].file).toBe(file);
    expect(bucket[id1].line).toBe(line);
    expect(typeof bucket[id1].updatedAt).toBe('number');
  });

  it('keeps separate entries for different lines in the same file', () => {
    useStore.getState().addDiffComment(sid, { file, line: 1, text: 'a' });
    useStore.getState().addDiffComment(sid, { file, line: 2, text: 'b' });

    const list = Object.values(useStore.getState().pendingDiffComments[sid] ?? {});
    expect(list).toHaveLength(2);
  });

  it('keeps separate entries for the same line in different files', () => {
    useStore.getState().addDiffComment(sid, { file: 'a.ts', line, text: 'a' });
    useStore.getState().addDiffComment(sid, { file: 'b.ts', line, text: 'b' });

    const list = Object.values(useStore.getState().pendingDiffComments[sid] ?? {});
    expect(list).toHaveLength(2);
  });

  it('trims the replacement text', () => {
    const id1 = useStore.getState().addDiffComment(sid, { file, line, text: 'first' });
    useStore.getState().addDiffComment(sid, { file, line, text: '  second  ' });

    const bucket = useStore.getState().pendingDiffComments[sid] ?? {};
    expect(bucket[id1].text).toBe('second');
  });
});
