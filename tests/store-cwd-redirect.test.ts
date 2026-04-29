import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useStore } from '../src/stores/store';
import type { Session } from '../src/types';

// Covers `_applyCwdRedirect` — the renderer-side patch invoked when main
// pushes `session:cwdRedirected` after the import-resume copy helper
// (#603 reviewer Layer-1 fix) relocates a JSONL into the spawn cwd's
// projectDir. Without this patch the sessionTitles SDK bridge would keep
// reading/writing the original (now-frozen) SOURCE JSONL because it keys
// off `session.cwd` for projectKey resolution.

function seedSession(id: string, cwd: string): void {
  const session: Session = {
    id,
    name: 'test',
    state: 'idle',
    cwd,
    model: '',
    groupId: 'g1',
    agentType: 'claude-code',
  };
  useStore.setState((s) => ({ sessions: [...s.sessions, session] }));
}

describe('store._applyCwdRedirect (#603)', () => {
  beforeEach(() => {
    useStore.setState({ sessions: [] });
  });
  afterEach(() => {
    useStore.setState({ sessions: [] });
  });

  it('patches session.cwd to the new spawn cwd', () => {
    seedSession('s-redirect', '/tmp/old-deleted');
    useStore.getState()._applyCwdRedirect('s-redirect', 'C:\\Users\\jiahuigu');
    const after = useStore.getState().sessions.find((s) => s.id === 's-redirect');
    expect(after?.cwd).toBe('C:\\Users\\jiahuigu');
  });

  it('is a no-op when the row is missing', () => {
    seedSession('s-other', '/tmp/other');
    useStore.getState()._applyCwdRedirect('s-missing', '/tmp/new');
    // Untouched neighbour proves we didn't accidentally append a ghost row.
    const sessions = useStore.getState().sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('s-other');
    expect(sessions[0].cwd).toBe('/tmp/other');
  });

  it('is a no-op when cwd is already current', () => {
    seedSession('s-same', '/tmp/already-here');
    const before = useStore.getState().sessions;
    useStore.getState()._applyCwdRedirect('s-same', '/tmp/already-here');
    // Reference-equal — we returned the original state object so subscribers
    // don't fire a needless re-render on a no-op redirect.
    expect(useStore.getState().sessions).toBe(before);
  });

  it('ignores empty newCwd', () => {
    seedSession('s-empty', '/tmp/keep');
    useStore.getState()._applyCwdRedirect('s-empty', '');
    const after = useStore.getState().sessions.find((s) => s.id === 's-empty');
    expect(after?.cwd).toBe('/tmp/keep');
  });

  it('only mutates the targeted session', () => {
    seedSession('s-a', '/tmp/a');
    seedSession('s-b', '/tmp/b');
    useStore.getState()._applyCwdRedirect('s-a', '/tmp/a-new');
    const sessions = useStore.getState().sessions;
    expect(sessions.find((s) => s.id === 's-a')?.cwd).toBe('/tmp/a-new');
    expect(sessions.find((s) => s.id === 's-b')?.cwd).toBe('/tmp/b');
  });
});
