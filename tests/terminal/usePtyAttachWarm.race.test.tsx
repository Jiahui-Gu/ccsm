// Hook-level race regression for `usePtyAttachWarm` (PR #1355 round-2
// cold review).
//
// Specific race being defended against:
//   1. Session S crashes while hidden — the registry's module-level
//      onExit listener writes `disconnectedSessions[S]` to the store.
//   2. User switches BACK to S. The `usePtyAttachWarm(S, ...)` mount
//      begins.
//   3. The disconnect-watch effect fires first (synchronously after the
//      attach effect kicks off its async chain) and sets local state to
//      `'exit'`.
//   4. The attach effect's async tail resolves and would naively
//      `setState({kind:'ready'}, 'attach-warm-complete')` — overwriting
//      'exit'. The watcher cannot re-fire because the disconnect
//      object's identity is unchanged → user stranded on 'ready' for
//      a dead session.
//
// The fix: BEFORE flipping to 'ready', the attach effect synchronously
// reads `useStore.getState().disconnectedSessions[sessionId]` and emits
// 'exit' instead when an entry exists. This test asserts the fix.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// ---- store mock ----------------------------------------------------------
// We need a live, mutable mock of the store that supports both the
// `useStore(selector)` subscription pattern AND `useStore.getState()`.
//
// The mock state has only the slices the warm hook touches:
//   - `_clearPtyExit(sid)`           — spy
//   - `pendingForkSource`            — empty (no copy-session in scope)
//   - `reloadNonce`                  — empty (no reload in scope)
//   - `disconnectedSessions[sid]`    — controlled per test
//
// Vitest hoists `vi.mock` factories above all top-level statements, so
// the spies and shared state object must be declared with `vi.hoisted`.
const { storeState, clearPtyExitSpy, applyPtyExitSpy } = vi.hoisted(() => {
  const clearPtyExitSpy = vi.fn();
  const applyPtyExitSpy = vi.fn();
  const storeState: {
    _clearPtyExit: ReturnType<typeof vi.fn>;
    _applyPtyExit: ReturnType<typeof vi.fn>;
    pendingForkSource: Record<string, string>;
    reloadNonce: Record<string, number>;
    disconnectedSessions: Record<
      string,
      { kind: 'clean' | 'crashed'; code: number | null; signal: string | number | null; at: number }
    >;
    scrollbackLines: number;
  } = {
    _clearPtyExit: clearPtyExitSpy,
    _applyPtyExit: applyPtyExitSpy,
    pendingForkSource: {},
    reloadNonce: {},
    disconnectedSessions: {},
    scrollbackLines: 1000,
  };
  return { storeState, clearPtyExitSpy, applyPtyExitSpy };
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

// ---- xterm mocks ---------------------------------------------------------
// The warm registry constructs real-ish Terminal instances. We supply
// minimal stand-ins so the hook can run through to its setState
// transitions without exploding on missing DOM behavior.
vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn(function () {
    const inst = {
      open: vi.fn(),
      loadAddon: vi.fn(),
      write: vi.fn((_s: string, cb?: () => void) => cb?.()),
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
        active: { viewportY: 0, baseY: 0, cursorY: 0, length: 0, type: 'normal' as const },
      },
      dispose: vi.fn(),
    };
    return inst;
  }),
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn(function () {
    return { fit: vi.fn() };
  }),
}));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: vi.fn(function () { return {}; }) }));
vi.mock('@xterm/addon-clipboard', () => ({ ClipboardAddon: vi.fn(function () { return {}; }) }));
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: vi.fn(function () { return {}; }) }));
vi.mock('@xterm/addon-canvas', () => ({ CanvasAddon: vi.fn(function () { return {}; }) }));

// Silence log.event probes.
vi.mock('../../src/shared/log', () => ({
  log: { event: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
  warn: vi.fn(),
  error: vi.fn(),
}));

// ---- imports (must come AFTER vi.mock calls) ----------------------------
import { usePtyAttachWarm } from '../../src/terminal/usePtyAttach.warm';
import { __resetRegistryForTests } from '../../src/terminal/xtermWarmRegistry';

// ---- pty bridge helpers --------------------------------------------------
function installFakePty(): void {
  (window as unknown as { ccsmPty: unknown }).ccsmPty = {
    attach: vi.fn(async () => ({ cols: 80, rows: 24, pid: 1234 })),
    spawn: vi.fn(async () => ({ ok: true, sid: 'unused', pid: 1234, cols: 80, rows: 24 })),
    detach: vi.fn(async () => undefined),
    input: vi.fn(async () => undefined),
    resize: vi.fn(async () => undefined),
    getBufferSnapshot: vi.fn(async () => ({ snapshot: 'SNAP', seq: 0 })),
    onData: vi.fn(() => () => undefined),
    onExit: vi.fn(() => () => undefined),
  };
}

function uninstallFakePty(): void {
  delete (window as unknown as { ccsmPty?: unknown }).ccsmPty;
}

// Drain the warm-hook's async chain (attach → snapshot → applySnapshot →
// pin rendezvous → setState). Three setTimeout-0 yields suffice — same
// pattern as the legacy harness's `settleAttach`.
async function settleAttach(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe('usePtyAttachWarm — disconnectedSessions race (round-2 review Major)', () => {
  let host: HTMLDivElement;
  let hostRef: { current: HTMLDivElement | null };

  beforeEach(() => {
    installFakePty();
    host = document.createElement('div');
    document.body.appendChild(host);
    hostRef = { current: host };
    storeState.pendingForkSource = {};
    storeState.reloadNonce = {};
    storeState.disconnectedSessions = {};
    clearPtyExitSpy.mockClear();
    applyPtyExitSpy.mockClear();
  });

  afterEach(() => {
    __resetRegistryForTests();
    document.body.removeChild(host);
    uninstallFakePty();
  });

  // The exact race: store already has disconnectedSessions[sid] when the
  // attach effect starts. Without the fix, the cold-path setState('ready')
  // would clobber the disconnect-watcher's setState('exit').
  it('cold attach to an already-crashed sid lands in exit state, NOT ready', async () => {
    storeState.disconnectedSessions['sid-crashed'] = {
      kind: 'crashed',
      code: null,
      signal: 'SIGSEGV',
      at: Date.now(),
    };
    const { result } = renderHook(() =>
      usePtyAttachWarm('sid-crashed', '/tmp', hostRef),
    );
    await settleAttach();

    expect(result.current.state.kind).toBe('exit');
    if (result.current.state.kind === 'exit') {
      expect(result.current.state.exitKind).toBe('crashed');
      expect(result.current.state.detail).toBe('signal SIGSEGV');
    }
    // Critical contract: _clearPtyExit must NOT be called when we land
    // in exit. Clearing would delete the diagnostic AND break the
    // watcher's identity comparison so the user could never escape a
    // bad 'ready' state.
    expect(clearPtyExitSpy).not.toHaveBeenCalled();
  });

  // Steady-state correctness — without a prior disconnect entry the
  // attach effect still flips to 'ready' as before, and clears any
  // stale ptyExit slice (matching legacy behaviour).
  it('cold attach to a healthy sid still lands in ready and clears ptyExit', async () => {
    const { result } = renderHook(() =>
      usePtyAttachWarm('sid-fresh', '/tmp', hostRef),
    );
    await settleAttach();

    expect(result.current.state.kind).toBe('ready');
    expect(clearPtyExitSpy).toHaveBeenCalledWith('sid-fresh');
  });

  // Warm path: pre-populate the registry by attaching once, then mount
  // again for the same sid with a disconnect entry in the store. The
  // warm completion path must ALSO resolve to 'exit' instead of 'ready'.
  it('warm reshow of an already-crashed sid lands in exit state, NOT ready', async () => {
    // First attach: healthy session lands in 'ready' and entry warmed.
    const first = renderHook(() => usePtyAttachWarm('sid-W', '/tmp', hostRef));
    await settleAttach();
    expect(first.result.current.state.kind).toBe('ready');
    first.unmount();

    // Now simulate: while no hook was mounted for sid-W, it crashed.
    // The module-level registry listener (which IS still subscribed —
    // see registry test for that contract) wrote disconnectedSessions.
    storeState.disconnectedSessions['sid-W'] = {
      kind: 'crashed',
      code: 1,
      signal: null,
      at: Date.now(),
    };
    clearPtyExitSpy.mockClear();

    // Re-mount: this is the "user switched back to a session that
    // crashed while hidden" flow. The warm path returns early after
    // reparent+fit+pin — without the fix, it would unconditionally
    // setState('ready') and clobber the disconnect watcher's 'exit'.
    const second = renderHook(() => usePtyAttachWarm('sid-W', '/tmp', hostRef));
    await settleAttach();
    expect(second.result.current.state.kind).toBe('exit');
    if (second.result.current.state.kind === 'exit') {
      expect(second.result.current.state.exitKind).toBe('crashed');
      expect(second.result.current.state.detail).toBe('exit code 1');
    }
    expect(clearPtyExitSpy).not.toHaveBeenCalled();
    second.unmount();
  });
});
