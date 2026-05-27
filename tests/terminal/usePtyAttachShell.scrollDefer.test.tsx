// Task #82: on cold-start, xterm.js's `.xterm-viewport` element needs at
// least one paint after `fit.fit()` before its `scrollTop` write will
// land at the bottom — the CanvasAddon / RenderService dimension cache
// hasn't settled yet, so a synchronous `scrollToBottom()` writes a
// clamped value (often 0) and the native `::-webkit-scrollbar-thumb`
// sits at the top while the content correctly paints at the bottom.
//
// Fix: defer `scrollToBottom() + focus() + setMask(false)` to a
// `requestAnimationFrame` callback so xterm has one paint to settle
// dimensions before we issue the scroll write and reveal the term.
//
// This test asserts the call-order contract: those three calls MUST run
// inside an rAF callback fired after `fit.fit()`, not synchronously.
// The real visual symptom (scrollbar thumb position in the DOM) is
// exercised by `scripts/dogfood-bug-82-scrollbar.mjs` — jsdom does not
// compute `.xterm-viewport` scroll geometry, so a call-order assertion
// is the faithful unit-level signal.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const { storeState, clearPtyExitSpy, scrollToBottomSpy, focusSpy, fitSpy } = vi.hoisted(() => {
  const clearPtyExitSpy = vi.fn();
  const scrollToBottomSpy = vi.fn();
  const focusSpy = vi.fn();
  const fitSpy = vi.fn();
  const storeState: {
    _clearPtyExit: ReturnType<typeof vi.fn>;
    pendingForkSource: Record<string, string>;
    reloadNonce: Record<string, number>;
    disconnectedSessions: Record<string, unknown>;
    sessions: Array<{ id: string; cwd: string }>;
    scrollbackLines: number;
    terminalFontSizePx: number;
  } = {
    _clearPtyExit: clearPtyExitSpy,
    pendingForkSource: {},
    reloadNonce: {},
    disconnectedSessions: {},
    sessions: [],
    scrollbackLines: 1000,
    terminalFontSizePx: 13,
  };
  return { storeState, clearPtyExitSpy, scrollToBottomSpy, focusSpy, fitSpy };
});

vi.mock('../../src/stores/store', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const useStore = ((selector: (s: any) => any) => selector(storeState)) as any;
  useStore.getState = () => storeState;
  useStore.setState = (
    patch:
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      | Record<string, any>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      | ((s: typeof storeState) => Record<string, any>),
  ) => {
    const next = typeof patch === 'function' ? patch(storeState) : patch;
    Object.assign(storeState, next ?? {});
  };
  return { useStore };
});

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn(function () {
    return {
      open: vi.fn(),
      loadAddon: vi.fn(),
      write: vi.fn((_s: string, cb?: () => void) => cb?.()),
      reset: vi.fn(),
      focus: focusSpy,
      scrollToBottom: scrollToBottomSpy,
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      resize: vi.fn(),
      cols: 80,
      rows: 24,
      unicode: { activeVersion: '6' },
      modes: { bracketedPasteMode: false },
      buffer: {
        active: { viewportY: 0, baseY: 0, cursorY: 0, length: 0, type: 'normal' as const },
      },
      dispose: vi.fn(),
    };
  }),
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn(function () {
    return { fit: fitSpy };
  }),
}));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: vi.fn(function () { return {}; }) }));
vi.mock('@xterm/addon-clipboard', () => ({ ClipboardAddon: vi.fn(function () { return {}; }) }));
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: vi.fn(function () { return {}; }) }));
vi.mock('@xterm/addon-canvas', () => ({ CanvasAddon: vi.fn(function () { return {}; }) }));

vi.mock('../../src/shared/log', () => ({
  log: { event: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
  warn: vi.fn(),
  error: vi.fn(),
}));

import { usePtyAttachShell } from '../../src/terminal/usePtyAttachShell';
import { __resetShellRegistryForTests } from '../../src/terminal/shellRegistry';

function installFakePty(): void {
  (window as unknown as { ccsmPty: unknown }).ccsmPty = {
    attach: vi.fn(async () => ({ cols: 80, rows: 24, pid: 1234 })),
    spawn: vi.fn(async () => ({ ok: true, sid: 'sid-A', pid: 1234, cols: 80, rows: 24 })),
    detach: vi.fn(async () => undefined),
    input: vi.fn(async () => undefined),
    resize: vi.fn(async () => undefined),
    kill: vi.fn(async () => undefined),
    getBufferSnapshot: vi.fn(async () => ({ snapshot: '', seq: 0 })),
    onData: vi.fn(() => () => undefined),
    onExit: vi.fn(() => () => undefined),
  };
}

function uninstallFakePty(): void {
  delete (window as unknown as { ccsmPty?: unknown }).ccsmPty;
}

// Manual rAF driver so the test controls when frames fire (rather than
// relying on jsdom's setTimeout-backed default).
type RafCb = (t: number) => void;
let rafQueue: RafCb[] = [];
function installManualRaf(): void {
  rafQueue = [];
  (globalThis as unknown as { requestAnimationFrame: (cb: RafCb) => number })
    .requestAnimationFrame = (cb: RafCb): number => {
      rafQueue.push(cb);
      return rafQueue.length;
    };
  (globalThis as unknown as { cancelAnimationFrame: (h: number) => void })
    .cancelAnimationFrame = (): void => {
      /* tests don't cancel */
    };
}
async function flushRaf(): Promise<void> {
  await act(async () => {
    const drain = rafQueue;
    rafQueue = [];
    for (const cb of drain) cb(performance.now());
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function settleMicrotasks(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

describe('usePtyAttachShell — cold-start scroll defer (#82)', () => {
  let host: HTMLDivElement;
  let hostRef: { current: HTMLDivElement | null };

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    hostRef = { current: host };
    storeState.pendingForkSource = {};
    storeState.reloadNonce = {};
    storeState.disconnectedSessions = {};
    storeState.sessions = [{ id: 'sid-A', cwd: 'C:/x' }];
    clearPtyExitSpy.mockClear();
    scrollToBottomSpy.mockClear();
    focusSpy.mockClear();
    fitSpy.mockClear();
    installManualRaf();
    installFakePty();
  });

  afterEach(() => {
    __resetShellRegistryForTests();
    document.body.removeChild(host);
    uninstallFakePty();
  });

  it('defers scrollToBottom + focus past at least one rAF after fit (cold path)', async () => {
    renderHook(() => usePtyAttachShell('sid-A', 'C:/x', hostRef));
    // Drain microtasks — runColdStartSuffix resolves up to (and including)
    // its fit.fit(), but the scroll/focus/unmask should now sit behind an
    // rAF that has NOT yet fired.
    await settleMicrotasks();

    expect(fitSpy).toHaveBeenCalledTimes(1);
    // Pre-rAF: deferred ops must NOT have run yet.
    expect(scrollToBottomSpy).not.toHaveBeenCalled();
    expect(focusSpy).not.toHaveBeenCalled();

    // Fire the rAF — now the deferred ops run.
    await flushRaf();
    await settleMicrotasks();
    // A belt-and-suspenders second rAF is allowed; flush again to be safe.
    await flushRaf();
    await settleMicrotasks();

    expect(scrollToBottomSpy).toHaveBeenCalled();
    expect(focusSpy).toHaveBeenCalled();
  });
});
