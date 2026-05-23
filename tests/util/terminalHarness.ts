// Shared terminal test harness.
//
// Three things every terminal-hook test used to hand-build, in slightly
// different shapes per file:
//   1. A fake xterm Terminal (write/reset/resize/focus/onData/scrollToBottom)
//   2. A fake `window.ccsmPty` bridge (attach/detach/spawn/onData/onExit/...)
//   3. Async settling for usePtyAttach's promise chain
//
// The divergence (per-file mock shapes, per-file flush-N-times) hid real
// drift: when usePtyAttach grew a `scrollToBottom` call, only one test file
// knew about it. This module is the single place to update.
//
// Why only one flavor of xterm mock helper here:
//   - vi.mock hoists to the top of the file, so the factory MUST be a fresh
//     object literal at hoist-time — we expose `createXtermSingletonMock()`
//     that callers reference inside their `vi.mock` factory. The shared
//     `Spies` object is mutated by the mock so tests can assert against it.
//   - The other terminal test file uses `vi.spyOn` directly against the real
//     singleton. Its domain-specific state machine for ordered writes is a
//     worse fit for this harness's shape, so we leave it as-is rather than
//     force-fit a helper around it.
import { vi, type Mock } from 'vitest';

// ---------------------------------------------------------------------------
// Fake xterm Terminal
// ---------------------------------------------------------------------------

export interface FakeTerminalSpies {
  write: Mock;
  reset: Mock;
  resize: Mock;
  focus: Mock;
  scrollToBottom: Mock;
  scrollToLine: Mock;
  onData: Mock;
  inputDisposableDispose: Mock;
}

export interface FakeBuffer {
  active: {
    baseY: number;
    viewportY: number;
    cursorY: number;
    length: number;
    type: 'normal' | 'alternate';
  };
}

export interface FakeTerminal extends FakeTerminalSpies {
  cols: number;
  rows: number;
  buffer: FakeBuffer;
  /** Ordered log of write/scrollToBottom/scrollToLine calls — for ordering assertions. */
  callLog: string[];
}

export function createFakeTerminal(opts: { cols?: number; rows?: number } = {}): FakeTerminal {
  const callLog: string[] = [];
  const inputDisposableDispose = vi.fn();
  const onDataDisposable = { dispose: inputDisposableDispose };
  return {
    // `write` invokes its drain callback synchronously so post-write
    // side-effects (scrollToBottom rendezvous) land in the same flush.
    write: vi.fn((data: string, cb?: () => void) => {
      callLog.push(`write:${data}`);
      if (cb) cb();
    }),
    reset: vi.fn(),
    resize: vi.fn(),
    focus: vi.fn(),
    scrollToBottom: vi.fn(() => {
      callLog.push('scrollToBottom');
    }),
    scrollToLine: vi.fn((line: number) => {
      callLog.push(`scrollToLine:${line}`);
    }),
    onData: vi.fn(() => onDataDisposable),
    inputDisposableDispose,
    cols: opts.cols ?? 80,
    rows: opts.rows ?? 24,
    buffer: { active: { baseY: 0, viewportY: 0, cursorY: 0, length: 0, type: 'normal' } },
    callLog,
  };
}

export interface FakeFit {
  fit: Mock;
  proposeDimensions: Mock;
}

export function createFakeFit(
  proposed: { cols: number; rows: number } = { cols: 134, rows: 51 },
): FakeFit {
  return {
    fit: vi.fn(),
    proposeDimensions: vi.fn(() => proposed),
  };
}

export function resetFakeTerminalSpies(t: FakeTerminal): void {
  t.write.mockClear();
  t.reset.mockClear();
  t.resize.mockClear();
  t.focus.mockClear();
  t.scrollToBottom.mockClear();
  t.scrollToLine.mockClear();
  t.onData.mockClear();
  t.inputDisposableDispose.mockClear();
  t.callLog.length = 0;
  t.buffer.active.baseY = 0;
  t.buffer.active.viewportY = 0;
  t.buffer.active.cursorY = 0;
  t.buffer.active.length = 0;
  t.buffer.active.type = 'normal';
  // Restore default implementations — individual tests may have called
  // `mockImplementation(...)` to capture async-schedule / event-ordering
  // semantics for the specific assertion they need. Without restoring,
  // those overrides leak into the NEXT test and break harness-level
  // callLog ordering assertions.
  t.write.mockImplementation((data: string, cb?: () => void) => {
    t.callLog.push(`write:${data}`);
    if (cb) cb();
  });
  t.scrollToBottom.mockImplementation(() => {
    t.callLog.push('scrollToBottom');
  });
  t.scrollToLine.mockImplementation((line: number) => {
    t.callLog.push(`scrollToLine:${line}`);
  });
}

// ---------------------------------------------------------------------------
// xterm singleton mock factory (for vi.mock-style tests)
//
// IMPORTANT: vi.mock is hoisted ABOVE all imports and the factory runs at
// dependency-resolution time — BEFORE the test file's top-level `const`
// initializations have run. So we cannot accept `FakeTerminal` directly:
// we'd capture it in the TDZ.
//
// Instead, accept getter functions. The vi.fn() wrappers below are lazy —
// they only call the getter when usePtyAttach actually reaches into the
// module — by which point the test file's top-level consts ARE initialised.
//
// Usage in a test file:
//
//   const fakeTerm = createFakeTerminal();
//   const fakeFit = createFakeFit();
//   vi.mock('../../src/terminal/xtermSingleton', () =>
//     createXtermSingletonMock(() => fakeTerm, () => fakeFit),
//   );
// ---------------------------------------------------------------------------

export function createXtermSingletonMock(
  getFakeTerm: () => FakeTerminal,
  getFakeFit: () => FakeFit,
): {
  ensureTerminal: Mock;
  getTerm: Mock;
  getFit: Mock;
  getActiveSid: Mock;
  setActiveSid: Mock;
  getUnsubscribeData: Mock;
  setUnsubscribeData: Mock;
  getInputDisposable: Mock;
  setInputDisposable: Mock;
  getSnapshotReplay: Mock;
  setSnapshotReplay: Mock;
  writeAndScrollToBottom: Mock;
  __resetSingletonForTests: Mock;
} {
  let activeSid: string | null = null;
  let unsub: (() => void) | null = null;
  let inDisp: { dispose: () => void } | null = null;
  let snapReplay: (() => Promise<void>) | null = null;
  return {
    ensureTerminal: vi.fn(),
    getTerm: vi.fn(() => getFakeTerm()),
    getFit: vi.fn(() => getFakeFit()),
    getActiveSid: vi.fn(() => activeSid),
    setActiveSid: vi.fn((s: string | null) => {
      activeSid = s;
    }),
    getUnsubscribeData: vi.fn(() => unsub),
    setUnsubscribeData: vi.fn((fn: (() => void) | null) => {
      unsub = fn;
    }),
    getInputDisposable: vi.fn(() => inDisp),
    setInputDisposable: vi.fn((d: { dispose: () => void } | null) => {
      inDisp = d;
    }),
    getSnapshotReplay: vi.fn(() => snapReplay),
    setSnapshotReplay: vi.fn((fn: (() => Promise<void>) | null) => {
      snapReplay = fn;
    }),
    // Mirror the real helper: `term.write('', cb)` then `cb()` scrolls.
    // The fake `write` invokes its cb synchronously, so this also runs
    // the scroll spy synchronously — perfect for ordering assertions.
    writeAndScrollToBottom: vi.fn((t: any) => {
      t.write('', () => t.scrollToBottom());
    }),
    __resetSingletonForTests: vi.fn(() => {
      activeSid = null;
      unsub = null;
      inDisp = null;
      snapReplay = null;
    }),
  };
}

// ---------------------------------------------------------------------------
// pty bridge factory
//
// Two API surfaces:
//   - `bridge` — drop into `(window as any).ccsmPty = bridge`
//   - `spies` — call-history mocks for assertions
//   - `fire.data(payload)` / `fire.exit(evt)` — invoke registered listeners
// ---------------------------------------------------------------------------

export type AttachResp = { snapshot: string; cols: number; rows: number; pid: number } | null;

export interface PtyBridgeOptions {
  /** First-attach response. Pass `null` to force the spawn-on-null fallback path. */
  attach?: AttachResp;
  /** Default snapshot returned by getBufferSnapshot when no deferred is armed. */
  snapshot?: { snapshot: string; seq: number };
  /** Default spawn response. */
  spawn?: { ok: true; sid: string; pid: number; cols: number; rows: number } | { ok: false; error: string };
}

export interface PtyBridgeHarness {
  bridge: {
    attach: Mock;
    detach: Mock;
    spawn: Mock;
    input: Mock;
    resize: Mock;
    onData: Mock;
    onExit: Mock;
    getBufferSnapshot: Mock;
  };
  spies: PtyBridgeHarness['bridge'] & { onDataUnsub: Mock; onExitUnsub: Mock };
  fire: {
    data: (p: { sid: string; chunk: string; seq: number }) => void;
    exit: (e: { sessionId: string; code?: number | null; signal?: string | number | null }) => void;
  };
}

export function createPtyBridge(opts: PtyBridgeOptions = {}): PtyBridgeHarness {
  const attachResp: AttachResp =
    opts.attach === undefined
      ? { snapshot: 'snap', cols: 80, rows: 24, pid: 1234 }
      : opts.attach;
  const snapshotResp: { snapshot: string; seq: number } =
    opts.snapshot ?? { snapshot: 'snap', seq: 0 };
  const spawnResp = opts.spawn ?? {
    ok: true as const,
    sid: '',
    pid: 999,
    cols: 80,
    rows: 24,
  };

  let onDataHandler: ((p: { sid: string; chunk: string; seq: number }) => void) | null = null;
  let onExitHandler:
    | ((evt: { sessionId: string; code?: number | null; signal?: string | number | null }) => void)
    | null = null;

  const detach = vi.fn(async (_sid: string) => undefined);
  const attach = vi.fn(async (_sid: string) => attachResp);
  const spawn = vi.fn(async (sid: string, _cwd: string, _forkSourceSid?: string) => {
    if (spawnResp.ok) return { ...spawnResp, sid };
    return spawnResp;
  });
  const input = vi.fn();
  const resize = vi.fn();
  const onDataUnsub = vi.fn();
  const onData = vi.fn((cb: (p: { sid: string; chunk: string; seq: number }) => void) => {
    onDataHandler = cb;
    return onDataUnsub;
  });
  const onExitUnsub = vi.fn();
  const onExit = vi.fn((cb: typeof onExitHandler) => {
    onExitHandler = cb;
    return onExitUnsub;
  });
  const getBufferSnapshot = vi.fn(async (_sid: string) => snapshotResp);

  const bridge = { attach, detach, spawn, input, resize, onData, onExit, getBufferSnapshot };
  return {
    bridge,
    spies: { ...bridge, onDataUnsub, onExitUnsub },
    fire: {
      data: (p) => onDataHandler?.(p),
      exit: (e) => onExitHandler?.(e),
    },
  };
}

export function installCcsmPty(bridge: PtyBridgeHarness['bridge']): void {
  (window as unknown as { ccsmPty: PtyBridgeHarness['bridge'] }).ccsmPty = bridge;
}

export function uninstallCcsmPty(): void {
  delete (window as unknown as { ccsmPty?: unknown }).ccsmPty;
}

// ---------------------------------------------------------------------------
// Async settle
//
// usePtyAttach's attach effect is an async IIFE that awaits
// attach → getBufferSnapshot → optionally pty.resize → replay. Each
// `setTimeout(0)` is a macrotask yield, which drains promise microtasks
// scheduled during the previous task. Three yields cover usePtyAttach's
// three-await chain. `settleAttach()` is the named replacement for the
// previous `await flush(); await flush(); await flush();` pattern — and
// it self-documents what we're waiting for.
//
// Use `settleAttach({ wrap: act })` when the test renders a hook via
// @testing-library/react and you want React to settle effects at the same
// time. We don't import `act` here to keep this module dep-light; the
// caller passes it in.
// ---------------------------------------------------------------------------

export async function settleAttach(opts?: {
  /** Pass `act` from @testing-library/react to wrap the settle. */
  wrap?: <T>(cb: () => Promise<T> | T) => Promise<T>;
  /** Override the number of macrotask yields (default 3). Bump for chains with extra awaits. */
  ticks?: number;
}): Promise<void> {
  const ticks = opts?.ticks ?? 3;
  const doFlush = async (): Promise<void> => {
    for (let i = 0; i < ticks; i += 1) {
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  };
  if (opts?.wrap) {
    await opts.wrap(doFlush);
  } else {
    await doFlush();
  }
}
