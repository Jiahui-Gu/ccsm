import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../src/stores/store';

// Covers the renderer-side classification rule for `pty:exit` events.
// Decision boundary is intentionally simple: signal == null && code === 0
// → clean (user typed `/exit` or claude returned). Anything else
// (signal present, non-zero code, both null) → crashed.
//
// `_clearPtyExit` is the cleanup hook called from TerminalPane when an
// attach/spawn succeeds — it must drop the entry without touching
// other sids.

describe('store._applyPtyExit / _clearPtyExit', () => {
  beforeEach(() => {
    useStore.setState({ disconnectedSessions: {} });
  });

  it('classifies clean exit (no signal, code 0)', () => {
    useStore.getState()._applyPtyExit('s-clean', { code: 0, signal: null });
    const entry = useStore.getState().disconnectedSessions['s-clean'];
    expect(entry?.kind).toBe('clean');
    expect(entry?.code).toBe(0);
    expect(entry?.signal).toBeNull();
    expect(typeof entry?.at).toBe('number');
  });

  it('classifies non-zero exit code as crashed', () => {
    useStore.getState()._applyPtyExit('s-code', { code: 1, signal: null });
    expect(useStore.getState().disconnectedSessions['s-code']?.kind).toBe('crashed');
  });

  it('classifies signal exit as crashed (string signal)', () => {
    useStore.getState()._applyPtyExit('s-sig', { code: null, signal: 'SIGTERM' });
    const e = useStore.getState().disconnectedSessions['s-sig'];
    expect(e?.kind).toBe('crashed');
    expect(e?.signal).toBe('SIGTERM');
  });

  it('classifies signal exit as crashed (numeric signal)', () => {
    useStore.getState()._applyPtyExit('s-sig-n', { code: null, signal: 15 });
    expect(useStore.getState().disconnectedSessions['s-sig-n']?.kind).toBe('crashed');
  });

  it('classifies all-null payload as crashed (unknown reason)', () => {
    useStore.getState()._applyPtyExit('s-unknown', { code: null, signal: null });
    expect(useStore.getState().disconnectedSessions['s-unknown']?.kind).toBe('crashed');
  });

  it('overwrites existing entry on second exit for same sid', () => {
    useStore.getState()._applyPtyExit('s-twice', { code: 0, signal: null });
    expect(useStore.getState().disconnectedSessions['s-twice']?.kind).toBe('clean');
    useStore.getState()._applyPtyExit('s-twice', { code: 137, signal: null });
    expect(useStore.getState().disconnectedSessions['s-twice']?.kind).toBe('crashed');
    expect(useStore.getState().disconnectedSessions['s-twice']?.code).toBe(137);
  });

  it('_clearPtyExit drops only the named sid', () => {
    useStore.getState()._applyPtyExit('s-a', { code: 1, signal: null });
    useStore.getState()._applyPtyExit('s-b', { code: 0, signal: null });
    useStore.getState()._clearPtyExit('s-a');
    expect(useStore.getState().disconnectedSessions['s-a']).toBeUndefined();
    expect(useStore.getState().disconnectedSessions['s-b']?.kind).toBe('clean');
  });

  it('_clearPtyExit on unknown sid is a no-op (returns same map ref)', () => {
    useStore.getState()._applyPtyExit('s-keep', { code: 1, signal: null });
    const before = useStore.getState().disconnectedSessions;
    useStore.getState()._clearPtyExit('s-nope');
    const after = useStore.getState().disconnectedSessions;
    // Same object reference — no spurious render churn for unrelated sids.
    expect(after).toBe(before);
  });
});
