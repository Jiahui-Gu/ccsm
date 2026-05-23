// Regression tests for the silent data-loss failure mode when the persist
// snapshot exceeds the IPC validator's size cap.
//
// Failure flow being pinned (pre-fix behaviour was a generic disk-space toast
// and no log — same wording whether the disk was full or the snapshot was a
// megabyte of sidebar reorganisation):
//
//   src/stores/persist.ts schedulePersist() -> window.ccsm.saveState()
//     -> preload throws Error('value_too_large')
//       -> onPersistError(err) fires -> usePersistErrorBridge toast
//
// We test three guarantees:
//   1. The on-disk row is not erased on rejection (the rejected payload
//      never reaches saveState, so a prior successful write survives a
//      subsequent oversize rejection).
//   2. The oversize rejection produces an *actionable* signal distinct from
//      the generic disk-error toast (persistent + has an action), and a
//      diagnostic console.error breadcrumb fires.
//   3. After the rejection, a smaller follow-up snapshot succeeds and would
//      be the value read back on next launch.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

import {
  schedulePersist,
  setPersistErrorHandler,
  type PersistedState,
} from '../src/stores/persist';
import { usePersistErrorBridge } from '../src/app-effects/usePersistErrorBridge';

function mkSnap(overrides: Partial<PersistedState> = {}): PersistedState {
  return {
    version: 1,
    sessions: [],
    groups: [],
    activeId: '',
    sidebarWidth: 260,
    theme: 'system',
    fontSize: 'md',
    fontSizePx: 14,
    ...overrides,
  };
}

/**
 * Stand-in for the main-process app_state row. The preload `saveState`
 * wrapper throws on `value_too_large`; this mock mirrors that contract so
 * the renderer-side persister sees a real rejection.
 */
function makeFakeCcsm() {
  let row: string | null = null;
  const calls: Array<{ key: string; value: string; ok: boolean; error?: string }> = [];
  const MAX = 1_000_000; // mirror MAX_STATE_VALUE_BYTES; raise alongside.
  const saveState = vi.fn(async (key: string, value: string) => {
    if (value.length > MAX) {
      calls.push({ key, value, ok: false, error: 'value_too_large' });
      throw new Error('value_too_large');
    }
    row = value;
    calls.push({ key, value, ok: true });
  });
  const loadState = vi.fn(async (_key: string) => row);
  return {
    api: { saveState, loadState },
    get row() {
      return row;
    },
    calls,
  };
}

let hadCcsm = false;
let prevCcsm: unknown;

function installCcsm(api: unknown) {
  const w = globalThis.window as unknown as Record<string, unknown>;
  hadCcsm = 'ccsm' in w;
  prevCcsm = w.ccsm;
  w.ccsm = api;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  setPersistErrorHandler(() => {});
  const w = globalThis.window as unknown as Record<string, unknown>;
  if (hadCcsm) {
    w.ccsm = prevCcsm;
  } else {
    delete w.ccsm;
  }
});

describe('persist: oversize snapshot rejection', () => {
  it('does not erase a prior successfully-persisted snapshot when a later write is rejected', async () => {
    const fake = makeFakeCcsm();
    installCcsm(fake.api);

    // First write: small, succeeds.
    schedulePersist(mkSnap({ sidebarWidth: 240 }));
    await vi.advanceTimersByTimeAsync(500);
    expect(fake.row).not.toBeNull();
    const goodSerialized = fake.row;
    expect(JSON.parse(goodSerialized as string).sidebarWidth).toBe(240);

    // Second write: oversize. Push a sessions array large enough to blow
    // past the cap. With a 1.1 MB payload the validator rejects before any
    // disk touch.
    const bloated: PersistedState['sessions'] = Array.from(
      { length: 4000 },
      (_, i) => ({
        id: `s-${i}`,
        title: 'x'.repeat(300),
        cwd: '/home/u/projects/whatever',
        model: 'claude-3-5-sonnet',
      }) as unknown as PersistedState['sessions'][number],
    );
    schedulePersist(mkSnap({ sidebarWidth: 999, sessions: bloated }));
    await vi.advanceTimersByTimeAsync(500);

    // Latest saveState call rejected.
    const last = fake.calls[fake.calls.length - 1];
    expect(last.ok).toBe(false);
    expect(last.error).toBe('value_too_large');

    // CRITICAL: the prior on-disk row is untouched — a next-launch read sees
    // the last known-good snapshot, not blank state.
    expect(fake.row).toBe(goodSerialized);
    expect(JSON.parse(fake.row as string).sidebarWidth).toBe(240);
  });

  it('surfaces an actionable, persistent toast and logs an error breadcrumb when the rejection is value_too_large', async () => {
    const fake = makeFakeCcsm();
    installCcsm(fake.api);

    const push = vi.fn();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderHook(() => usePersistErrorBridge({ push }));

    const bloated: PersistedState['sessions'] = Array.from(
      { length: 4000 },
      (_, i) => ({
        id: `s-${i}`,
        title: 'x'.repeat(300),
        cwd: '/home/u',
        model: 'claude-3-5-sonnet',
      }) as unknown as PersistedState['sessions'][number],
    );
    schedulePersist(mkSnap({ sessions: bloated }));
    await vi.advanceTimersByTimeAsync(500);
    // Let the saveState catch microtask settle so the persist handler fires.
    await vi.advanceTimersByTimeAsync(0);

    expect(push).toHaveBeenCalled();
    const toast = push.mock.calls[0][0] as {
      kind: string;
      title: string;
      body?: string;
      persistent?: boolean;
      action?: { label: string; onClick: () => void };
    };
    expect(toast.kind).toBe('error');
    // Distinct, actionable signal — not the generic disk-space message.
    expect(toast.persistent).toBe(true);
    // Either an action button or a title that names the size problem — both
    // give the user something concrete to do other than ignore the toast.
    const hint = `${toast.title} ${toast.body ?? ''}`.toLowerCase();
    expect(hint).toMatch(/size|too large|export|reduce/);

    // Diagnostic breadcrumb for the next support session.
    const logged = errSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toMatch(/oversize|value_too_large/i);
    errSpy.mockRestore();
  });

  it('after a rejection, a smaller follow-up snapshot succeeds and becomes the value read on next launch', async () => {
    const fake = makeFakeCcsm();
    installCcsm(fake.api);

    // First: small good write.
    schedulePersist(mkSnap({ sidebarWidth: 240 }));
    await vi.advanceTimersByTimeAsync(500);

    // Then: oversize rejection.
    const bloated: PersistedState['sessions'] = Array.from(
      { length: 4000 },
      (_, i) => ({
        id: `s-${i}`,
        title: 'x'.repeat(300),
        cwd: '/h',
        model: 'm',
      }) as unknown as PersistedState['sessions'][number],
    );
    schedulePersist(mkSnap({ sidebarWidth: 800, sessions: bloated }));
    await vi.advanceTimersByTimeAsync(500);

    // Now a smaller follow-up snapshot — user dropped most sessions.
    schedulePersist(mkSnap({ sidebarWidth: 320 }));
    await vi.advanceTimersByTimeAsync(500);

    // Last write succeeded, and the on-disk row reflects it.
    const last = fake.calls[fake.calls.length - 1];
    expect(last.ok).toBe(true);
    const persisted = JSON.parse(fake.row as string);
    expect(persisted.sidebarWidth).toBe(320);

    // Next-launch read goes through loadState — verify it returns the
    // smaller snapshot, not the oversize one (which never touched disk).
    const reread = await fake.api.loadState('main');
    expect(JSON.parse(reread as string).sidebarWidth).toBe(320);
  });
});
