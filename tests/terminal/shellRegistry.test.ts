// Unit tests for the per-session shell registry (`shellRegistry.ts`).
//
// The visual DOM model and z-stack are exercised in jsdom; the cold-start
// IPC pipeline is covered end-to-end by `scripts/dogfood-attach-redesign.mjs`
// (real Electron + real PTY). These tests focus on:
//   - getShell returns null before createShell, the shell after
//   - showShell flips display + z-index, never reparents
//   - createShell is idempotent on a sid already present
//   - disposeAll tears down everything
//   - PTY chunk router buffers then drains on applySnapshot

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock xterm constructors so we don't spin up real terminals in jsdom.
const { terminalCtor, addonCtor } = vi.hoisted(() => {
  const terminalCtor = vi.fn(function () {
    return {
      open: vi.fn(),
      loadAddon: vi.fn(),
      write: vi.fn((_s: string, cb?: () => void) => {
        if (cb) cb();
      }),
      dispose: vi.fn(),
      reset: vi.fn(),
      focus: vi.fn(),
      scrollToBottom: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onSelectionChange: vi.fn(() => ({ dispose: vi.fn() })),
      attachCustomKeyEventHandler: vi.fn(),
      getSelection: vi.fn(() => ''),
      clearSelection: vi.fn(),
      selectAll: vi.fn(),
      resize: vi.fn(),
      cols: 80,
      rows: 24,
      unicode: { activeVersion: '6' },
      modes: { bracketedPasteMode: false },
      buffer: {
        active: { viewportY: 0, baseY: 0, cursorY: 0, length: 0, type: 'normal' },
      },
      options: { scrollback: 1000, fontSize: 13 },
      textarea: undefined,
    };
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

vi.mock('../../src/shared/log', () => ({
  log: { event: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
  warn: vi.fn(),
  error: vi.fn(),
}));

const { applyPtyExitSpy } = vi.hoisted(() => ({ applyPtyExitSpy: vi.fn() }));
vi.mock('../../src/stores/store', () => {
  const state = {
    scrollbackLines: 1000,
    terminalFontSizePx: 13,
    disconnectedSessions: {},
    _applyPtyExit: applyPtyExitSpy,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const useStore = ((selector: (s: any) => any) => selector(state)) as any;
  useStore.getState = () => state;
  useStore.setState = () => undefined;
  return { useStore };
});

import {
  applySnapshot,
  createShell,
  disposeAll,
  disposeShell,
  getActiveSid,
  getShell,
  getShellCount,
  showShell,
  __resetRegistryForTests,
} from '../../src/terminal/shellRegistry';

type DataPayload = { sid: string; chunk: string; seq: number };

describe('shellRegistry', () => {
  let host: HTMLDivElement;
  let onDataListeners: Array<(p: DataPayload) => void>;
  let onExitListeners: Array<(p: { sessionId: string; code: number | null; signal: number | null }) => void>;
  let attachResults: Map<string, { cols: number; rows: number; pid: number } | null>;
  let snapshotResults: Map<string, { snapshot: string; seq: number }>;

  beforeEach(() => {
    onDataListeners = [];
    onExitListeners = [];
    attachResults = new Map();
    snapshotResults = new Map();
    (window as unknown as { ccsmPty: unknown }).ccsmPty = {
      onData: (cb: (p: DataPayload) => void) => {
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
      attach: vi.fn(async (sid: string) =>
        attachResults.has(sid)
          ? attachResults.get(sid)
          : { cols: 80, rows: 24, pid: 1234 },
      ),
      spawn: vi.fn(async (sid: string) => ({ ok: true, sid, pid: 1234, cols: 80, rows: 24 })),
      getBufferSnapshot: vi.fn(async (sid: string) =>
        snapshotResults.has(sid)
          ? snapshotResults.get(sid)
          : { snapshot: '', seq: 0 },
      ),
      input: vi.fn(),
      resize: vi.fn(async () => undefined),
      clipboard: { readText: vi.fn(() => ''), writeText: vi.fn() },
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

  it('getShell returns null before createShell, the shell after', async () => {
    expect(getShell('sid-a')).toBeNull();
    const state = await createShell('sid-a', host, '/tmp');
    expect(state.kind).toBe('ready');
    const shell = getShell('sid-a');
    expect(shell).not.toBeNull();
    expect(shell?.sid).toBe('sid-a');
    expect(getShellCount()).toBe(1);
    expect(getActiveSid()).toBe('sid-a');
    expect(shell?.wrapper.parentElement).toBe(host);
  });

  it('createShell on an existing sid is idempotent (no second Terminal alloc)', async () => {
    await createShell('sid-a', host, '/tmp');
    terminalCtor.mockClear();
    const state = await createShell('sid-a', host, '/tmp');
    expect(state.kind).toBe('ready');
    expect(terminalCtor).not.toHaveBeenCalled();
    expect(getShellCount()).toBe(1);
  });

  it('showShell flips display + z-index on every shell, never reparents', async () => {
    await createShell('sid-a', host, '/tmp');
    await createShell('sid-b', host, '/tmp');
    const shellA = getShell('sid-a')!;
    const shellB = getShell('sid-b')!;
    // Both wrappers under the same host — no offscreen holder.
    expect(shellA.wrapper.parentElement).toBe(host);
    expect(shellB.wrapper.parentElement).toBe(host);
    // After creating B, B is active.
    expect(getActiveSid()).toBe('sid-b');
    expect(shellA.wrapper.style.display).toBe('none');
    expect(shellA.wrapper.style.zIndex).toBe('0');
    expect(shellB.wrapper.style.display).toBe('');
    expect(shellB.wrapper.style.zIndex).toBe('1');
    // Switch back to A — pure DOM flip.
    showShell('sid-a');
    expect(getActiveSid()).toBe('sid-a');
    expect(shellA.wrapper.style.display).toBe('');
    expect(shellA.wrapper.style.zIndex).toBe('1');
    expect(shellB.wrapper.style.display).toBe('none');
    expect(shellB.wrapper.style.zIndex).toBe('0');
    // Neither wrapper moved out of the host.
    expect(shellA.wrapper.parentElement).toBe(host);
    expect(shellB.wrapper.parentElement).toBe(host);
  });

  it('showShell on an unknown sid returns null and does not throw', () => {
    expect(showShell('nope')).toBeNull();
  });

  it('per-shell pty.onData subscription buffers chunks until applySnapshot, then drains seq > snapSeq', async () => {
    // Pre-seed snapshot result so createShell can complete.
    snapshotResults.set('sid-a', { snapshot: 'SNAP', seq: 4 });
    // Don't await createShell yet — we need to inject live chunks while
    // it's mid-flight (buffering window).
    const pending = createShell('sid-a', host, '/tmp');
    // Fan a 'late' chunk in BEFORE createShell completes. Find the
    // most-recent listener (the one allocShell just installed).
    await Promise.resolve();
    await Promise.resolve();
    const listener = onDataListeners[onDataListeners.length - 1]!;
    listener({ sid: 'sid-a', chunk: 'live-tail', seq: 5 });
    listener({ sid: 'sid-a', chunk: 'pre-snap', seq: 3 });
    await pending;
    // After snapshot apply (seq=4), live-tail (seq 5 > 4) was drained;
    // pre-snap (seq 3 <= 4) was dropped.
    const term = terminalCtor.mock.results[0]!.value;
    const writeCalls = (term.write as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0] as string)
      .filter((s) => s.length > 0);
    expect(writeCalls).toContain('SNAP');
    expect(writeCalls).toContain('live-tail');
    expect(writeCalls).not.toContain('pre-snap');
  });

  it('applySnapshot is idempotent on unknown sid', () => {
    expect(() => applySnapshot('nope', 0)).not.toThrow();
  });

  it('disposeAll tears down every shell + listener', async () => {
    await createShell('sid-a', host, '/tmp');
    await createShell('sid-b', host, '/tmp');
    expect(getShellCount()).toBe(2);
    expect(onDataListeners.length).toBe(2);
    const a = getShell('sid-a')!;
    const b = getShell('sid-b')!;
    disposeAll();
    expect(getShellCount()).toBe(0);
    expect(getShell('sid-a')).toBeNull();
    expect(getShell('sid-b')).toBeNull();
    expect(getActiveSid()).toBeNull();
    expect(a.wrapper.parentElement).toBeNull();
    expect(b.wrapper.parentElement).toBeNull();
    expect((a.term as unknown as { dispose: ReturnType<typeof vi.fn> }).dispose)
      .toHaveBeenCalledTimes(1);
    expect((b.term as unknown as { dispose: ReturnType<typeof vi.fn> }).dispose)
      .toHaveBeenCalledTimes(1);
    expect(onDataListeners.length).toBe(0);
  });

  it('disposeShell removes one shell and detaches its listener', async () => {
    await createShell('sid-a', host, '/tmp');
    expect(onDataListeners.length).toBe(1);
    disposeShell('sid-a', 'reload');
    expect(getShell('sid-a')).toBeNull();
    expect(onDataListeners.length).toBe(0);
  });

  it('module-level pty.onExit listener fans every sid into the store', async () => {
    await createShell('sid-a', host, '/tmp');
    // Crash a hidden session that has no shell — exit must still reach
    // the store so the user sees the exit overlay when they switch in.
    expect(onExitListeners.length).toBeGreaterThan(0);
    for (const cb of onExitListeners) {
      cb({ sessionId: 'sid-hidden', code: 1, signal: null });
    }
    expect(applyPtyExitSpy).toHaveBeenCalledWith('sid-hidden', { code: 1, signal: null });
  });
});
