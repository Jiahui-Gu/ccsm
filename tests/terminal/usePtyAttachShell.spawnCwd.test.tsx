// Task #81 / #79a: on reload, `pty.spawn` must receive the session's
// CURRENT cwd (the value held in the store), not an empty string or a
// stale prop value. The bug: user reloads a session whose original cwd
// is a project dir; after reload, claude prints
// `Accessing workspace: C:\Users\jiahuigu` (HOME) and pops the
// "trust this folder?" prompt.
//
// Root cause: `runColdStartSuffix` in `usePtyAttachShell.ts` was
// passing `cwd ?? ''` to `pty.spawn`. The `cwd` prop is a render-time
// shadow that can be empty (App.tsx falls back to '' when
// `active.cwd` is missing) or stale (a tool-driven `_applyCwdRedirect`
// mutates `session.cwd` mid-session and the new value may not yet have
// rendered down to this hook). Main's `resolveSpawnCwd` interprets
// empty/missing as `homedir()`.
//
// Fix: at spawn time, read cwd from the store (`session.cwd`) — the
// store is the source of truth.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const { storeState, clearPtyExitSpy, syncScrollAreaSpy } = vi.hoisted(() => {
  const clearPtyExitSpy = vi.fn();
  const syncScrollAreaSpy = vi.fn();
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
  return { storeState, clearPtyExitSpy, syncScrollAreaSpy };
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
      // reconcileView (shellRegistry) reaches into term._core to force a
      // synchronous syncScrollArea(true) on every showShell reveal (#82).
      // The installed @xterm/xterm 5.5.0 bundle stores the field as
      // `_viewport` on the core; expose the spy there so the reconcile lands.
      _core: { _viewport: { syncScrollArea: syncScrollAreaSpy } },
      dispose: vi.fn(),
    };
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

vi.mock('../../src/shared/log', () => ({
  log: { event: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
  warn: vi.fn(),
  error: vi.fn(),
}));

import { usePtyAttachShell } from '../../src/terminal/usePtyAttachShell';
import {
  showShell,
  __resetShellRegistryForTests,
} from '../../src/terminal/shellRegistry';

type SpawnFn = (sid: string, cwd: string, forkSourceSid?: string) => Promise<unknown>;

function installFakePty(spawnImpl: SpawnFn): { spawn: ReturnType<typeof vi.fn> } {
  const spawn = vi.fn(spawnImpl);
  (window as unknown as { ccsmPty: unknown }).ccsmPty = {
    // attach returns null → forces the spawn branch (cold path).
    attach: vi.fn(async () => null),
    spawn,
    detach: vi.fn(async () => undefined),
    input: vi.fn(async () => undefined),
    resize: vi.fn(async () => undefined),
    kill: vi.fn(async () => undefined),
    getBufferSnapshot: vi.fn(async () => ({ snapshot: '', seq: 0 })),
    onData: vi.fn(() => () => undefined),
    onExit: vi.fn(() => () => undefined),
  };
  return { spawn };
}

function uninstallFakePty(): void {
  delete (window as unknown as { ccsmPty?: unknown }).ccsmPty;
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe('usePtyAttachShell — spawn cwd source-of-truth (#79a)', () => {
  let host: HTMLDivElement;
  let hostRef: { current: HTMLDivElement | null };

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    hostRef = { current: host };
    storeState.pendingForkSource = {};
    storeState.reloadNonce = {};
    storeState.disconnectedSessions = {};
    storeState.sessions = [];
    clearPtyExitSpy.mockClear();
    syncScrollAreaSpy.mockClear();
  });

  afterEach(() => {
    __resetShellRegistryForTests();
    document.body.removeChild(host);
    uninstallFakePty();
  });

  // The exact bug: prop `cwd` is empty (App.tsx fallback) but the store
  // holds the real cwd. Without the fix, pty.spawn was called with ''
  // and main's resolveSpawnCwd defaulted to homedir() → trust prompt.
  it('uses store session.cwd when prop cwd is empty (reload with stale prop)', async () => {
    const realCwd = 'C:/Users/jiahuigu/projects/ccsm';
    storeState.sessions = [{ id: 'sid-A', cwd: realCwd }];
    const { spawn } = installFakePty(async () => ({
      ok: true, sid: 'sid-A', pid: 1234, cols: 80, rows: 24,
    }));

    renderHook(() => usePtyAttachShell('sid-A', '', hostRef));
    await settle();

    expect(spawn).toHaveBeenCalledTimes(1);
    const callArgs = spawn.mock.calls[0]!;
    expect(callArgs[0]).toBe('sid-A');
    expect(callArgs[1]).toBe(realCwd);
    expect(callArgs[1]).not.toBe('');
  });

  // Prop carries a stale value (e.g. project cwd before a `cd` redirect);
  // store has the up-to-date cwd. Fix prefers store.
  it('uses store session.cwd when it differs from prop (cwd redirect race)', async () => {
    const staleProp = 'C:/Users/jiahuigu/projects/foo';
    const liveStoreCwd = 'C:/Users/jiahuigu/projects/foo/subdir';
    storeState.sessions = [{ id: 'sid-B', cwd: liveStoreCwd }];
    const { spawn } = installFakePty(async () => ({
      ok: true, sid: 'sid-B', pid: 1234, cols: 80, rows: 24,
    }));

    renderHook(() => usePtyAttachShell('sid-B', staleProp, hostRef));
    await settle();

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]![1]).toBe(liveStoreCwd);
  });

  // Defensive: if the session is not in the store (e.g. transient race),
  // fall back to the prop so we don't regress to '' when the prop is
  // actually valid.
  it('falls back to prop cwd when session missing from store', async () => {
    const propCwd = 'C:/Users/jiahuigu/projects/bar';
    storeState.sessions = [];
    const { spawn } = installFakePty(async () => ({
      ok: true, sid: 'sid-C', pid: 1234, cols: 80, rows: 24,
    }));

    renderHook(() => usePtyAttachShell('sid-C', propCwd, hostRef));
    await settle();

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]![1]).toBe(propCwd);
  });
});

// Task #82: revealing a visited shell (`showShell`) must force
// xterm's `syncScrollArea(true)` so the native `.xterm-viewport`
// scrollbar's DOM `scrollTop` is re-derived from xterm's `ydisp`. Webkit
// silently zeroes scrollTop on the `display:none → ''` reveal with NO
// scroll event, and `syncScrollArea(false)` short-circuits — only the
// forced (`true`) variant rewrites scrollTop and re-syncs the thumb.
describe('shellRegistry — viewport reconcile on reveal (#82)', () => {
  let host: HTMLDivElement;
  let hostRef: { current: HTMLDivElement | null };

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    hostRef = { current: host };
    storeState.pendingForkSource = {};
    storeState.reloadNonce = {};
    storeState.disconnectedSessions = {};
    storeState.sessions = [];
    syncScrollAreaSpy.mockClear();
  });

  afterEach(() => {
    __resetShellRegistryForTests();
    document.body.removeChild(host);
    uninstallFakePty();
  });

  // Mount two cold shells so both are resident; the second is top. Then a
  // visited-switch back to the first must reconcile its viewport.
  async function mountTwoShells(): Promise<void> {
    storeState.sessions = [
      { id: 'sid-A', cwd: 'C:/a' },
      { id: 'sid-B', cwd: 'C:/b' },
    ];
    installFakePty(async (sid: string) => ({
      ok: true, sid, pid: 1234, cols: 80, rows: 24,
    }));
    renderHook(() => usePtyAttachShell('sid-A', '', hostRef));
    await settle();
    renderHook(() => usePtyAttachShell('sid-B', '', hostRef));
    await settle();
  }

  it('calls syncScrollArea(true) on the visited reveal (showShell)', async () => {
    await mountTwoShells();
    syncScrollAreaSpy.mockClear();
    showShell('sid-A');
    expect(syncScrollAreaSpy).toHaveBeenCalledWith(true);
  });

  it('reconciles on the cold reveal too (showShell during createShell)', async () => {
    await mountTwoShells();
    // Cold start promotes each shell via showShell → reconcileView runs;
    // so syncScrollArea(true) was already called during mount.
    expect(syncScrollAreaSpy).toHaveBeenCalledWith(true);
  });

  it('forces the sync (true), never the no-op false variant', async () => {
    await mountTwoShells();
    syncScrollAreaSpy.mockClear();
    showShell('sid-A');
    expect(syncScrollAreaSpy).toHaveBeenCalledWith(true);
    expect(syncScrollAreaSpy).not.toHaveBeenCalledWith(false);
  });
});
