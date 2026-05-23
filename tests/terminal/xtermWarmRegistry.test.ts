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

import {
  ensureAndShowEntry,
  disposeEntry,
  getEntry,
  getActiveSid,
  getWarmCacheSize,
  __resetRegistryForTests,
} from '../../src/terminal/xtermWarmRegistry';

describe('xtermWarmRegistry', () => {
  let host: HTMLDivElement;
  let onDataListeners: Array<(p: { sid: string; chunk: string }) => void>;

  beforeEach(() => {
    onDataListeners = [];
    (window as unknown as { ccsmPty: unknown }).ccsmPty = {
      onData: (cb: (p: { sid: string; chunk: string }) => void) => {
        onDataListeners.push(cb);
        return () => {
          const i = onDataListeners.indexOf(cb);
          if (i >= 0) onDataListeners.splice(i, 1);
        };
      },
    };
    host = document.createElement('div');
    document.body.appendChild(host);
    terminalCtor.mockClear();
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

  it('per-entry pty.onData subscription writes ONLY chunks for the entry\'s sid', () => {
    ensureAndShowEntry('sid-a', host);
    ensureAndShowEntry('sid-b', host);
    // Two listeners installed — one per entry.
    expect(onDataListeners.length).toBe(2);
    // The Terminal instances are returned in order: index 0 is sid-a, 1 is sid-b.
    const termA = terminalCtor.mock.results[0].value as { write: ReturnType<typeof vi.fn> };
    const termB = terminalCtor.mock.results[1].value as { write: ReturnType<typeof vi.fn> };
    termA.write.mockClear();
    termB.write.mockClear();
    // Fan out a chunk for sid-a: only termA receives it.
    for (const cb of onDataListeners) cb({ sid: 'sid-a', chunk: 'hello' });
    expect(termA.write).toHaveBeenCalledWith('hello');
    expect(termB.write).not.toHaveBeenCalled();
    // Fan out a chunk for sid-b: only termB receives it.
    termA.write.mockClear();
    for (const cb of onDataListeners) cb({ sid: 'sid-b', chunk: 'world' });
    expect(termB.write).toHaveBeenCalledWith('world');
    expect(termA.write).not.toHaveBeenCalled();
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
});
