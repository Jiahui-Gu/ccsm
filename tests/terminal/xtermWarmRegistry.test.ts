// Registry semantics for the per-session warm xterm (PR #25). These tests
// exercise the Map/LRU/lifecycle logic in jsdom; the visual DOM-reparent
// flow is empirical-only per the parent brief.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock xterm constructors so we don't spin up real terminals in jsdom.
// `vi.hoisted` runs before the imports below.
const { terminalCtor, addonCtor } =
  vi.hoisted(() => {
    const terminalCtor = vi.fn(function () {
      // Per-instance spies so two Terminals in the same test track
      // their own writes / disposals independently.
      const inst = {
        open: vi.fn(),
        loadAddon: vi.fn(),
        write: vi.fn(),
        dispose: vi.fn(),
        reset: vi.fn(),
        focus: vi.fn(),
        scrollToBottom: vi.fn(),
        onData: vi.fn(() => ({ dispose: vi.fn() })),
        resize: vi.fn(),
        cols: 80,
        rows: 24,
        unicode: { activeVersion: '6' },
        modes: { bracketedPasteMode: false },
        buffer: {
          active: { viewportY: 0, baseY: 0, cursorY: 0, length: 0, type: 'normal' },
        },
      };
      return inst;
    });
    const addonCtor = vi.fn(function () {
      return { fit: vi.fn() };
    });
    return { terminalCtor, addonCtor };
  });

vi.mock('@xterm/xterm', () => ({ Terminal: terminalCtor }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: addonCtor }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: vi.fn(function () { return {}; }) }));
vi.mock('@xterm/addon-clipboard', () => ({ ClipboardAddon: vi.fn(function () { return {}; }) }));
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: vi.fn(function () { return {}; }) }));
vi.mock('@xterm/addon-canvas', () => ({ CanvasAddon: vi.fn(function () { return {}; }) }));

// Quiet log.event probes — they're not under test here.
vi.mock('../../src/shared/log', () => ({
  log: { event: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
  warn: vi.fn(),
  error: vi.fn(),
}));

// Mock the store — the registry calls `useStore.getState()._applyPtyExit`
// from its module-level onExit listener (Major 2 fix). The spy lets us
// assert that exits for ALL sids (including hidden ones) reach the store.
const { applyPtyExitSpy } = vi.hoisted(() => ({ applyPtyExitSpy: vi.fn() }));
vi.mock('../../src/stores/store', () => {
  const state = {
    scrollbackLines: 1000,
    _applyPtyExit: applyPtyExitSpy,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const useStore = ((selector: (s: any) => any) => selector(state)) as any;
  useStore.getState = () => state;
  useStore.setState = () => undefined;
  return { useStore };
});

import {
  ensureAndShowEntry,
  applySnapshot,
  disposeEntry,
  getEntry,
  getActiveSid,
  getWarmCacheSize,
  __resetRegistryForTests,
} from '../../src/terminal/xtermWarmRegistry';

describe('xtermWarmRegistry', () => {
  let host: HTMLDivElement;
  let onDataListeners: Array<(p: { sid: string; chunk: string; seq: number }) => void>;
  let onExitListeners: Array<(p: { sessionId: string; code: number | null; signal: number | null }) => void>;

  beforeEach(() => {
    onDataListeners = [];
    onExitListeners = [];
    (window as unknown as { ccsmPty: unknown }).ccsmPty = {
      onData: (cb: (p: { sid: string; chunk: string; seq: number }) => void) => {
        onDataListeners.push(cb);
        return () => {
          const i = onDataListeners.indexOf(cb);
          if (i >= 0) onDataListeners.splice(i, 1);
        };
      },
      onExit: (cb: (p: { sessionId: string; code: number | null; signal: number | null }) => void) => {
        onExitListeners.push(cb);
        return () => {
          const i = onExitListeners.indexOf(cb);
          if (i >= 0) onExitListeners.splice(i, 1);
        };
      },
    };
    host = document.createElement('div');
    document.body.appendChild(host);
    terminalCtor.mockClear();
    applyPtyExitSpy.mockClear();
  });

  afterEach(() => {
    __resetRegistryForTests();
    document.body.removeChild(host);
    delete (window as unknown as { ccsmPty?: unknown }).ccsmPty;
    delete (window as unknown as { ccsm?: unknown }).ccsm;
  });

  it('first attach to a sid allocates a warm entry (isCold === true)', () => {
    const { entry, isCold } = ensureAndShowEntry('sid-a', host);
    expect(isCold).toBe(true);
    expect(entry.sid).toBe('sid-a');
    expect(getWarmCacheSize()).toBe(1);
    expect(getActiveSid()).toBe('sid-a');
    // Terminal constructed exactly once for sid-a.
    expect(terminalCtor).toHaveBeenCalledTimes(1);
    // Wrapper is parented under the host.
    expect(entry.wrapper.parentElement).toBe(host);
  });

  it('second attach to the same sid reuses the cached entry (isCold === false)', () => {
    const { entry: e1 } = ensureAndShowEntry('sid-a', host);
    terminalCtor.mockClear();
    // Simulate user switching away then back: hide via switch to sid-b
    // then return to sid-a.
    const host2 = document.createElement('div');
    document.body.appendChild(host2);
    ensureAndShowEntry('sid-b', host2);
    const { entry: e2, isCold } = ensureAndShowEntry('sid-a', host);
    expect(isCold).toBe(false);
    expect(e2).toBe(e1);
    // No new Terminal was constructed for the re-show.
    const ctorCallsForReshow = terminalCtor.mock.calls.length;
    // sid-b allocated one; sid-a reshow allocated zero. So total since
    // clear is exactly 1 (the sid-b alloc).
    expect(ctorCallsForReshow).toBe(1);
    expect(getActiveSid()).toBe('sid-a');
    // sid-a's wrapper is back under host after the reparent.
    expect(e2.wrapper.parentElement).toBe(host);
    document.body.removeChild(host2);
  });

  it('honors a custom WARM_CAP override and LRU-evicts the least-recently-shown entry on overflow', () => {
    (window as unknown as { ccsm: unknown }).ccsm = {
      featureFlags: { warmXterm: true, warmXtermCap: 3 },
    };

    // Discrete time stamps so lastAccessedAt has stable ordering. The
    // registry reads Date.now() — we stub it.
    let now = 1000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);

    // Fill cache: 1, 2, 3.
    ensureAndShowEntry('sid-1', host);
    now = 1010;
    ensureAndShowEntry('sid-2', host);
    now = 1020;
    ensureAndShowEntry('sid-3', host);
    expect(getWarmCacheSize()).toBe(3);
    // Bump sid-1 so it's NOT the LRU.
    now = 1030;
    ensureAndShowEntry('sid-1', host);
    // sid-2 is now the least-recently-shown that is neither active (sid-1)
    // nor about-to-be-allocated (sid-4).
    now = 1040;
    ensureAndShowEntry('sid-4', host);
    expect(getWarmCacheSize()).toBe(3);
    expect(getEntry('sid-1')).toBeDefined();
    expect(getEntry('sid-2')).toBeUndefined();
    expect(getEntry('sid-3')).toBeDefined();
    expect(getEntry('sid-4')).toBeDefined();
    nowSpy.mockRestore();
  });

  it('per-entry pty.onData subscription buffers chunks until applySnapshot, then drains seq > snapSeq', () => {
    ensureAndShowEntry('sid-a', host);
    ensureAndShowEntry('sid-b', host);
    // Two listeners installed — one per entry.
    expect(onDataListeners.length).toBe(2);
    const termA = terminalCtor.mock.results[0].value as { write: ReturnType<typeof vi.fn> };
    const termB = terminalCtor.mock.results[1].value as { write: ReturnType<typeof vi.fn> };
    termA.write.mockClear();
    termB.write.mockClear();
    // Fan out two chunks for sid-a in 'buffering' mode (default at alloc).
    // NOTHING should be written to either term yet — Major 1 fix: the
    // listener stashes by seq instead of writing-then-being-reset.
    for (const cb of onDataListeners) cb({ sid: 'sid-a', chunk: 'pre1', seq: 1 });
    for (const cb of onDataListeners) cb({ sid: 'sid-a', chunk: 'pre2', seq: 2 });
    expect(termA.write).not.toHaveBeenCalled();
    expect(termB.write).not.toHaveBeenCalled();
    // Also confirm the sid filter still routes correctly: a sid-b chunk
    // is buffered ONLY against entry-b's router (we can't peek directly,
    // but post-applySnapshot drain proves it).
    for (const cb of onDataListeners) cb({ sid: 'sid-b', chunk: 'bee1', seq: 1 });
    expect(termA.write).not.toHaveBeenCalled();
    expect(termB.write).not.toHaveBeenCalled();
    // Apply snap with snapSeq=1: drains buffered chunks with seq > 1
    // (i.e. just 'pre2'), drops 'pre1' as already-in-snapshot.
    applySnapshot('sid-a', 1);
    expect(termA.write).toHaveBeenCalledTimes(1);
    expect(termA.write).toHaveBeenCalledWith('pre2');
    // sid-b is still in 'buffering' mode — applySnapshot is per-sid.
    expect(termB.write).not.toHaveBeenCalled();
    // After applySnapshot, sid-a is in 'live' mode: a new chunk with
    // seq > 1 writes directly; seq <= 1 is dropped.
    termA.write.mockClear();
    for (const cb of onDataListeners) cb({ sid: 'sid-a', chunk: 'live3', seq: 3 });
    expect(termA.write).toHaveBeenCalledWith('live3');
    // A late chunk with seq <= snapSeq is defensively dropped.
    termA.write.mockClear();
    for (const cb of onDataListeners) cb({ sid: 'sid-a', chunk: 'stale', seq: 1 });
    expect(termA.write).not.toHaveBeenCalled();
    // sid-b's buffer is preserved; applySnapshot for sid-b drains it.
    applySnapshot('sid-b', 0);
    expect(termB.write).toHaveBeenCalledWith('bee1');
  });

  // Major 1 from cold review — the critical regression: live chunks that
  // arrive between `pty.attach` resolve and snapshot-land must NOT be
  // dropped. Before the fix, the listener wrote them straight to term,
  // then the cold path called term.reset() — silently consuming the
  // chunks. Now they're buffered, and `applySnapshot` drains them.
  it('Major 1: chunks arriving after attach but before snapshot are NOT lost across term.reset', () => {
    ensureAndShowEntry('sid-a', host);
    const termA = terminalCtor.mock.results[0].value as {
      write: ReturnType<typeof vi.fn>;
      reset: ReturnType<typeof vi.fn>;
    };
    termA.write.mockClear();
    termA.reset.mockClear();

    // Simulate the cold-attach window: chunks arrive while listener is
    // still buffering.
    for (const cb of onDataListeners) cb({ sid: 'sid-a', chunk: 'live-tail-A', seq: 5 });
    for (const cb of onDataListeners) cb({ sid: 'sid-a', chunk: 'live-tail-B', seq: 6 });

    // Cold attach: reset, write snapshot, applySnapshot.
    termA.reset();
    // (snapshot is hypothetically captured at seq=4 — chunks with seq > 4
    // are live tail after the snapshot's atomic capture point.)
    termA.write('SNAPSHOT_CONTENT');
    applySnapshot('sid-a', 4);

    // After the rendezvous, term must have received: SNAPSHOT_CONTENT,
    // then live-tail-A, then live-tail-B (the dedupe gate keeps both —
    // their seq 5 and 6 are > snapSeq 4).
    const writeCalls = termA.write.mock.calls.map((c) => c[0]);
    expect(writeCalls).toEqual(['SNAPSHOT_CONTENT', 'live-tail-A', 'live-tail-B']);
    // Critically: the chunks survived the reset() call sandwiched in
    // between — they were never silently dropped.
  });

  it('disposeEntry disposes the term, unsubs the data listener, and removes from the map', () => {
    const { entry } = ensureAndShowEntry('sid-a', host);
    const term = entry.term as unknown as { dispose: ReturnType<typeof vi.fn> };
    expect(onDataListeners.length).toBe(1);
    expect(entry.wrapper.parentElement).toBe(host);
    disposeEntry('sid-a', 'lru');
    expect(getEntry('sid-a')).toBeUndefined();
    expect(getWarmCacheSize()).toBe(0);
    expect(term.dispose).toHaveBeenCalledTimes(1);
    // Listener unsubscribed.
    expect(onDataListeners.length).toBe(0);
    // Wrapper detached from DOM.
    expect(entry.wrapper.parentElement).toBeNull();
  });

  it('disposeEntry on an unknown sid is a no-op', () => {
    expect(() => disposeEntry('nope', 'lru')).not.toThrow();
    expect(getWarmCacheSize()).toBe(0);
  });

  it('default cap is 20 when no env override is present', () => {
    // Confirm by attaching 21 distinct sids and observing one eviction.
    let now = 0;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => ++now);
    for (let i = 0; i < 20; i += 1) ensureAndShowEntry(`sid-${i}`, host);
    expect(getWarmCacheSize()).toBe(20);
    // sid-0 is the LRU (allocated and shown first, never re-shown).
    // sid-19 is currently active.
    ensureAndShowEntry('sid-20', host);
    expect(getWarmCacheSize()).toBe(20);
    expect(getEntry('sid-0')).toBeUndefined();
    expect(getEntry('sid-20')).toBeDefined();
    expect(getEntry('sid-19')).toBeDefined();
    nowSpy.mockRestore();
  });

  // Major 2 from cold review — backgrounded sessions that crash must
  // still land in `disconnectedSessions[sid]` so the user sees the exit
  // overlay on switch-back. The registry installs a single module-level
  // onExit listener that dispatches `_applyPtyExit` for EVERY sid,
  // including ones whose hook isn't currently mounted.
  it('Major 2: module-level onExit listener dispatches store._applyPtyExit for ALL sids', () => {
    // Trigger registry init by allocating an entry.
    ensureAndShowEntry('sid-foreground', host);
    expect(onExitListeners.length).toBe(1);
    // Exit for the foreground sid — recorded.
    onExitListeners[0]({ sessionId: 'sid-foreground', code: 0, signal: null });
    expect(applyPtyExitSpy).toHaveBeenCalledTimes(1);
    expect(applyPtyExitSpy).toHaveBeenLastCalledWith('sid-foreground', { code: 0, signal: null });
    // Exit for a DIFFERENT sid (e.g. a session that was switched away
    // from before crashing) — MUST also be recorded. The legacy hook
    // filtered these out via `evt.sessionId !== getActiveSid()` and is
    // the precise bug Major 2 fixes.
    onExitListeners[0]({ sessionId: 'sid-hidden-and-crashed', code: 1, signal: null });
    expect(applyPtyExitSpy).toHaveBeenCalledTimes(2);
    expect(applyPtyExitSpy).toHaveBeenLastCalledWith('sid-hidden-and-crashed', { code: 1, signal: null });
  });

  // Major 3 from cold review — `CCSM_WARM_XTERM_CAP=1` is unsafe because
  // both the incoming sid AND the active sid are exempt from LRU
  // eviction, leaving no viable victim when the user switches to a new
  // sid against a full cache. We clamp UP to 2 (silently — friendlier
  // than crashing on a config typo).
  it('cap override of 1 is clamped up to WARM_CAP_MIN=2 (Major 3 fix)', () => {
    (window as unknown as { ccsm: unknown }).ccsm = {
      featureFlags: { warmXterm: true, warmXtermCap: 1 },
    };
    let now = 0;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => ++now);
    ensureAndShowEntry('sid-1', host);
    ensureAndShowEntry('sid-2', host);
    expect(getWarmCacheSize()).toBe(2);
    // Adding a 3rd evicts the LRU non-active (sid-1; sid-2 is active),
    // leaving size === 2. With the broken clamp (floor=1) the eviction
    // loop would find no victim and `set()` would push size to 3.
    ensureAndShowEntry('sid-3', host);
    expect(getWarmCacheSize()).toBe(2);
    expect(getEntry('sid-1')).toBeUndefined();
    expect(getEntry('sid-2')).toBeDefined();
    expect(getEntry('sid-3')).toBeDefined();
    nowSpy.mockRestore();
  });
});
