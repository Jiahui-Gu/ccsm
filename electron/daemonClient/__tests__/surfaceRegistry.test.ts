// Tests for the daemon surface registry shim (Task #103, frag-6-7 §6.8 r7).

import { describe, expect, it } from 'vitest';
import { createDaemonSurfaceRegistry } from '../surfaceRegistry';

describe('daemonSurfaceRegistry', () => {
  it('starts in idle state', () => {
    const r = createDaemonSurfaceRegistry();
    expect(r.get().state).toBe('idle');
  });

  it('updates changedAt only when state actually changes', () => {
    let t = 1000;
    const r = createDaemonSurfaceRegistry({ now: () => t });
    const t0 = r.get().changedAt;
    t = 2000;
    r.set('idle'); // same state — no-op
    expect(r.get().changedAt).toBe(t0);
    r.set('reconnecting');
    expect(r.get().state).toBe('reconnecting');
    expect(r.get().changedAt).toBe(2000);
  });

  it('fires subscribers synchronously on state change', () => {
    const r = createDaemonSurfaceRegistry();
    const events: string[] = [];
    const unsub = r.subscribe((s) => events.push(s.state));
    r.set('reconnecting');
    r.set('reconnecting'); // no fan-out
    r.set('reconnected');
    unsub();
    r.set('idle'); // no fan-out after unsub
    expect(events).toEqual(['reconnecting', 'reconnected']);
  });

  it('supports multiple subscribers', () => {
    const r = createDaemonSurfaceRegistry();
    const a: string[] = [];
    const b: string[] = [];
    r.subscribe((s) => a.push(s.state));
    r.subscribe((s) => b.push(s.state));
    r.set('reconnecting');
    expect(a).toEqual(['reconnecting']);
    expect(b).toEqual(['reconnecting']);
  });
});
