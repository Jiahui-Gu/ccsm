import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Capture context-menu listener + popup invocations from the BrowserWindow
// mock. Each test flushes via beforeEach so `popupCalls.length === 0` is the
// reverse-verify baseline that proves the listener actually wired up.
const popupCalls: Array<{ items: unknown[]; window: unknown }> = [];

// Stash for the most-recently-constructed BrowserWindow mock. The `createWindow`
// factory builds the window via `new BrowserWindow(...)` (not a deps-injected
// ctor — the deps bag intentionally only carries cross-module references), so
// the only seam is `vi.mock('electron')`. The mock ctor pushes the latest
// instance into `latestWin` so each factory test can drive its listeners.
interface FakeWin {
  ctorOpts: Record<string, unknown>;
  listeners: Map<string, (...args: unknown[]) => void>;
  webContentsListeners: Map<string, (...args: unknown[]) => void>;
  hide: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  loadURL: ReturnType<typeof vi.fn>;
  loadFile: ReturnType<typeof vi.fn>;
  isDestroyed: ReturnType<typeof vi.fn>;
  isMaximized: ReturnType<typeof vi.fn>;
  setMenuBarVisibility: ReturnType<typeof vi.fn>;
  webContents: {
    on: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    setWindowOpenHandler: ReturnType<typeof vi.fn>;
    openDevTools: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
    setBackgroundThrottling: ReturnType<typeof vi.fn>;
    isDestroyed: ReturnType<typeof vi.fn>;
  };
  on: ReturnType<typeof vi.fn>;
}

let latestWin: FakeWin | null = null;
let appQuitMock: ReturnType<typeof vi.fn>;

function makeFakeWin(opts: Record<string, unknown>): FakeWin {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const webContentsListeners = new Map<string, (...args: unknown[]) => void>();
  const win: FakeWin = {
    ctorOpts: opts,
    listeners,
    webContentsListeners,
    hide: vi.fn(),
    show: vi.fn(),
    loadURL: vi.fn(),
    loadFile: vi.fn(),
    isDestroyed: vi.fn(() => false),
    isMaximized: vi.fn(() => false),
    setMenuBarVisibility: vi.fn(),
    webContents: {
      on: vi.fn((evt: string, cb: (...args: unknown[]) => void) => {
        webContentsListeners.set(evt, cb);
      }),
      send: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      openDevTools: vi.fn(),
      focus: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      isDestroyed: vi.fn(() => false),
    },
    on: vi.fn((evt: string, cb: (...args: unknown[]) => void) => {
      listeners.set(evt, cb);
    }),
  };
  return win;
}

vi.mock('electron', () => {
  const Menu = {
    buildFromTemplate: (items: unknown[]) => ({
      popup: (opts: { window: unknown }) =>
        popupCalls.push({ items, window: opts.window }),
    }),
  };
  class BrowserWindow {
    constructor(opts: Record<string, unknown>) {
      const w = makeFakeWin(opts);
      latestWin = w;
      // Returning an object from a constructor overrides `this`, so the
      // factory's `win` variable is the same FakeWin we expose via
      // `latestWin` — re-stubbing methods on `latestWin` (e.g.
      // `latestWin.isMaximized = vi.fn(() => true)`) is observed by the
      // factory's captured listeners.
      return w as unknown as BrowserWindow;
    }
  }
  const app = {
    quit: (...args: unknown[]) => appQuitMock(...args),
    isPackaged: false,
  };
  return { BrowserWindow, Menu, app };
});

// Mock the close-action prefs module — both reads + writes are observed.
const getCloseActionMock = vi.fn<[], 'ask' | 'tray' | 'quit'>(() => 'tray');
const setCloseActionMock = vi.fn();
vi.mock('../../prefs/closeAction', () => ({
  getCloseAction: () => getCloseActionMock(),
  setCloseAction: (v: 'ask' | 'tray' | 'quit') => setCloseActionMock(v),
}));

// i18n + branding are leaf imports we don't want to exercise.
vi.mock('../../i18n', () => ({
  tCloseDialog: (k: string) => `close.${k}`,
}));
vi.mock('../../branding/icon', () => ({
  buildAppIcon: () => ({ __mockIcon: true }),
}));

import {
  installContextMenu,
  isAllowedNavigation,
  decideCloseAction,
  createWindow,
  CLOSE_ASK_TIMEOUT_MS,
  type CreateWindowDeps,
} from '../createWindow';

interface ContextMenuParams {
  selectionText: string;
  isEditable: boolean;
  editFlags: {
    canCut: boolean;
    canCopy: boolean;
    canPaste: boolean;
    canSelectAll: boolean;
  };
}

type ContextMenuListener = (event: unknown, params: ContextMenuParams) => void;

function makeFakeWindow() {
  const listeners: ContextMenuListener[] = [];
  const win = {
    webContents: {
      on: (event: string, listener: ContextMenuListener) => {
        if (event === 'context-menu') listeners.push(listener);
      },
    },
  };
  return {
    win: win as unknown as Parameters<typeof installContextMenu>[0],
    fire: (params: ContextMenuParams) => {
      for (const l of listeners) l({}, params);
    },
    listenerCount: () => listeners.length,
  };
}

describe('installContextMenu', () => {
  beforeEach(() => {
    popupCalls.length = 0;
  });

  it('registers a single context-menu listener on the window webContents', () => {
    const fake = makeFakeWindow();
    installContextMenu(fake.win);
    expect(fake.listenerCount()).toBe(1);
  });

  it('shows copy + select-all on a non-editable surface with selection', () => {
    const fake = makeFakeWindow();
    installContextMenu(fake.win);
    fake.fire({
      selectionText: 'hello',
      isEditable: false,
      editFlags: {
        canCut: false,
        canCopy: true,
        canPaste: false,
        canSelectAll: true,
      },
    });
    expect(popupCalls).toHaveLength(1);
    const items = popupCalls[0].items as Array<Record<string, unknown>>;
    // Non-editable: cut + paste are skipped; copy is enabled because selection
    // is non-empty AND canCopy is true; separator + selectAll always trail.
    expect(items.map((i) => i.role)).toEqual(['copy', undefined, 'selectAll']);
    expect(items[0].enabled).toBe(true);
    expect(items[2].enabled).toBe(true);
  });

  it('shows cut/copy/paste + selectAll on an editable surface', () => {
    const fake = makeFakeWindow();
    installContextMenu(fake.win);
    fake.fire({
      selectionText: 'word',
      isEditable: true,
      editFlags: {
        canCut: true,
        canCopy: true,
        canPaste: true,
        canSelectAll: true,
      },
    });
    expect(popupCalls).toHaveLength(1);
    const items = popupCalls[0].items as Array<Record<string, unknown>>;
    expect(items.map((i) => i.role)).toEqual([
      'cut',
      'copy',
      'paste',
      undefined,
      'selectAll',
    ]);
    for (const i of items.filter((x) => x.role !== undefined)) {
      expect(i.enabled).toBe(true);
    }
  });

  it('disables copy when selection is empty', () => {
    const fake = makeFakeWindow();
    installContextMenu(fake.win);
    fake.fire({
      selectionText: '   ',
      isEditable: false,
      editFlags: {
        canCut: false,
        canCopy: true,
        canPaste: false,
        canSelectAll: true,
      },
    });
    const items = popupCalls[0].items as Array<Record<string, unknown>>;
    const copy = items.find((i) => i.role === 'copy');
    expect(copy?.enabled).toBe(false);
  });

  it('disables paste when canPaste is false on editable surface', () => {
    const fake = makeFakeWindow();
    installContextMenu(fake.win);
    fake.fire({
      selectionText: '',
      isEditable: true,
      editFlags: {
        canCut: false,
        canCopy: false,
        canPaste: false,
        canSelectAll: true,
      },
    });
    const items = popupCalls[0].items as Array<Record<string, unknown>>;
    const paste = items.find((i) => i.role === 'paste');
    expect(paste?.enabled).toBe(false);
  });
});

// #804 risk #7: the previous allowlist hardcoded `http://localhost:4100`
// in addition to the env-driven port. Stale dev port + dev build = bypass
// surface. The decider here only honors the env-driven origin (and `file:`
// for the prod renderer load).
describe('isAllowedNavigation (#804 risk #7)', () => {
  it('allows the env-driven dev origin', () => {
    expect(isAllowedNavigation('http://localhost:5174/foo', '5174')).toBe(true);
  });

  it('allows file: protocol for production renderer load', () => {
    expect(isAllowedNavigation('file:///C:/app/renderer/index.html', '5174')).toBe(true);
  });

  it('falls back to port 4100 when env var unset', () => {
    expect(isAllowedNavigation('http://localhost:4100/x', undefined)).toBe(true);
    expect(isAllowedNavigation('http://localhost:4100/x', '')).toBe(true);
  });

  it('blocks the legacy hardcoded localhost:4100 when env points elsewhere', () => {
    // The bug being fixed: when CCSM_DEV_PORT=5174, navigation to
    // localhost:4100 must be denied. Previously both ports were allowed.
    expect(isAllowedNavigation('http://localhost:4100/evil', '5174')).toBe(false);
  });

  it('blocks arbitrary external origins', () => {
    expect(isAllowedNavigation('https://evil.example.com/', '5174')).toBe(false);
    expect(isAllowedNavigation('http://attacker.test/x', '4100')).toBe(false);
  });

  it('blocks malformed URLs (returns false instead of throwing)', () => {
    expect(isAllowedNavigation('not a url', '4100')).toBe(false);
    expect(isAllowedNavigation('', '4100')).toBe(false);
  });

  it('blocks other protocols (javascript:, data:)', () => {
    expect(isAllowedNavigation('javascript:alert(1)', '4100')).toBe(false);
    expect(isAllowedNavigation('data:text/html,<script>x</script>', '4100')).toBe(false);
  });
});

// #1253: the in-app close dialog routes the user's choice back to main as
// `{choice, dontAskAgain}`. `decideCloseAction` is the pure mapping
// from that response → {action, persist}. Locked semantics:
//   * 'cancel' NEVER persists, even when dontAskAgain is checked —
//     cancelling must never trap the user into a pref they can't undo.
//   * 'tray' / 'quit' + dontAskAgain → persist that choice as the new
//     close-action preference.
describe('decideCloseAction (#1253)', () => {
  it('tray + dontAskAgain off → tray action, no persist', () => {
    expect(decideCloseAction({ choice: 'tray', dontAskAgain: false })).toEqual({
      action: 'tray',
      persist: null,
    });
  });

  it('tray + dontAskAgain on → tray action, persist tray', () => {
    expect(decideCloseAction({ choice: 'tray', dontAskAgain: true })).toEqual({
      action: 'tray',
      persist: 'tray',
    });
  });

  it('quit + dontAskAgain off → quit action, no persist', () => {
    expect(decideCloseAction({ choice: 'quit', dontAskAgain: false })).toEqual({
      action: 'quit',
      persist: null,
    });
  });

  it('quit + dontAskAgain on → quit action, persist quit', () => {
    expect(decideCloseAction({ choice: 'quit', dontAskAgain: true })).toEqual({
      action: 'quit',
      persist: 'quit',
    });
  });

  it('cancel + dontAskAgain off → cancel action, no persist', () => {
    expect(decideCloseAction({ choice: 'cancel', dontAskAgain: false })).toEqual({
      action: 'cancel',
      persist: null,
    });
  });

  it('cancel + dontAskAgain ON → cancel action, STILL no persist', () => {
    // The "never trap the user" rule. A user who hits Cancel and ticks
    // the box at the same time has given contradictory signals; we
    // discard the tick. Persisting 'cancel' would be meaningless anyway
    // (no such close-pref value), but the broader policy also forbids
    // persisting any pref on the cancel path.
    expect(decideCloseAction({ choice: 'cancel', dontAskAgain: true })).toEqual({
      action: 'cancel',
      persist: null,
    });
  });
});

// Factory-level coverage. The pure helpers above are well-tested, but the
// `createWindow()` body itself (lines 174-476 — BrowserWindow ctor opts,
// `will-navigate` hookup, dev-vs-prod load branch, the close-action choreography
// across `tray | quit | ask` × `CCSM_DEV_QUIT_ON_CLOSE` × `isQuitting`, and the
// IPC ask-dialog round-trip) was uncovered. These cases drive the factory
// through the captured listener map so each branch is hit deterministically
// without booting Electron.
describe('createWindow factory', () => {
  let ipcHandlers: Map<string, (...args: unknown[]) => void>;
  let removedIpcChannels: string[];
  let deps: CreateWindowDeps;
  let isQuittingFlag: boolean;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    popupCalls.length = 0;
    latestWin = null;
    isQuittingFlag = false;
    appQuitMock = vi.fn();
    getCloseActionMock.mockReset().mockReturnValue('tray');
    setCloseActionMock.mockReset();
    ipcHandlers = new Map();
    removedIpcChannels = [];
    // Default env: not e2e-hidden, no dev-quit override, no custom port.
    delete process.env.CCSM_E2E_HIDDEN;
    delete process.env.CCSM_DEV_QUIT_ON_CLOSE;
    delete process.env.CCSM_DEV_PORT;
    deps = {
      isDev: false,
      getActiveSid: vi.fn(() => null),
      onFocusChange: vi.fn(),
      getIsQuitting: vi.fn(() => isQuittingFlag),
      setIsQuitting: vi.fn((v: boolean) => {
        isQuittingFlag = v;
      }),
      ipcMain: {
        on: vi.fn((channel: string, cb: (...args: unknown[]) => void) => {
          ipcHandlers.set(channel, cb);
        }),
        removeListener: vi.fn((channel: string) => {
          removedIpcChannels.push(channel);
        }),
      } as unknown as CreateWindowDeps['ipcMain'],
    };
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    warnSpy.mockRestore();
  });

  // ─── BrowserWindow ctor opts (hidden-mode positioning + skipTaskbar) ──
  it('non-hidden launch creates a normally-positioned window', () => {
    createWindow(deps);
    expect(latestWin).not.toBeNull();
    expect(latestWin!.ctorOpts.x).toBeUndefined();
    expect(latestWin!.ctorOpts.y).toBeUndefined();
    expect(latestWin!.ctorOpts.skipTaskbar).toBe(false);
    expect(latestWin!.ctorOpts.show).toBe(true);
  });

  it('CCSM_E2E_HIDDEN=1 positions window offscreen and hides from taskbar', () => {
    process.env.CCSM_E2E_HIDDEN = '1';
    createWindow(deps);
    expect(latestWin!.ctorOpts.x).toBe(-32000);
    expect(latestWin!.ctorOpts.y).toBe(-32000);
    expect(latestWin!.ctorOpts.skipTaskbar).toBe(true);
    // Hidden mode also primes Chromium-level focus and disables throttling.
    expect(latestWin!.webContents.focus).toHaveBeenCalled();
    expect(latestWin!.webContents.setBackgroundThrottling).toHaveBeenCalledWith(false);
  });

  // ─── dev vs prod renderer load ─────────────────────────────────────────
  it('dev mode loads the webpack-dev-server URL on the configured port', () => {
    process.env.CCSM_DEV_PORT = '5174';
    createWindow({ ...deps, isDev: true });
    expect(latestWin!.loadURL).toHaveBeenCalledWith('http://localhost:5174');
    expect(latestWin!.loadFile).not.toHaveBeenCalled();
    // DevTools open in detached mode when not e2e-hidden.
    expect(latestWin!.webContents.openDevTools).toHaveBeenCalledWith({ mode: 'detach' });
  });

  it('dev mode falls back to port 4100 when CCSM_DEV_PORT unset', () => {
    createWindow({ ...deps, isDev: true });
    expect(latestWin!.loadURL).toHaveBeenCalledWith('http://localhost:4100');
  });

  it('prod mode loads the packaged renderer file', () => {
    createWindow(deps);
    expect(latestWin!.loadFile).toHaveBeenCalled();
    expect(latestWin!.loadURL).not.toHaveBeenCalled();
  });

  // ─── will-navigate guard wiring (delegates to isAllowedNavigation) ────
  it('will-navigate prevents external URL navigation', () => {
    createWindow(deps);
    const willNav = latestWin!.webContentsListeners.get('will-navigate')!;
    expect(willNav).toBeDefined();
    const evt = { preventDefault: vi.fn() };
    willNav(evt, 'https://evil.example.com/');
    expect(evt.preventDefault).toHaveBeenCalled();
  });

  it('will-navigate allows the configured dev-server origin', () => {
    process.env.CCSM_DEV_PORT = '4100';
    createWindow(deps);
    const willNav = latestWin!.webContentsListeners.get('will-navigate')!;
    const evt = { preventDefault: vi.fn() };
    willNav(evt, 'http://localhost:4100/index.html');
    expect(evt.preventDefault).not.toHaveBeenCalled();
  });

  // ─── window-open handler denies popups (preload-leak hardening) ───────
  it('blocks renderer-initiated window.open() calls', () => {
    createWindow(deps);
    const handler = latestWin!.webContents.setWindowOpenHandler.mock.calls[0][0];
    expect(handler()).toEqual({ action: 'deny' });
  });

  // ─── focus / maximize forwarding ──────────────────────────────────────
  it('focus event forwards activeSid to onFocusChange', () => {
    deps.getActiveSid = vi.fn(() => 'sid-42');
    createWindow(deps);
    latestWin!.listeners.get('focus')!();
    expect(deps.onFocusChange).toHaveBeenCalledWith({ focused: true, activeSid: 'sid-42' });
  });

  it('maximize/unmaximize broadcast window:maximizedChanged', () => {
    createWindow(deps);
    latestWin!.isMaximized = vi.fn(() => true);
    latestWin!.listeners.get('maximize')!();
    expect(latestWin!.webContents.send).toHaveBeenCalledWith('window:maximizedChanged', true);
    latestWin!.isMaximized = vi.fn(() => false);
    latestWin!.listeners.get('unmaximize')!();
    expect(latestWin!.webContents.send).toHaveBeenLastCalledWith('window:maximizedChanged', false);
  });

  it('show event re-sends window:afterShow so renderer can clear fade opacity', () => {
    createWindow(deps);
    latestWin!.webContents.send.mockClear();
    latestWin!.listeners.get('show')!();
    expect(latestWin!.webContents.send).toHaveBeenCalledWith('window:afterShow');
  });

  // ─── close-action: tray (default) → fade-then-hide ────────────────────
  it('close with pref=tray prevents default and fades to hide after 180ms', () => {
    getCloseActionMock.mockReturnValue('tray');
    createWindow(deps);
    const closeEvt = { preventDefault: vi.fn() };
    latestWin!.listeners.get('close')!(closeEvt);
    expect(closeEvt.preventDefault).toHaveBeenCalled();
    // Renderer is told to start fading first.
    expect(latestWin!.webContents.send).toHaveBeenCalledWith('window:beforeHide', { durationMs: 180 });
    // Hide is deferred to the end of the fade window.
    expect(latestWin!.hide).not.toHaveBeenCalled();
    vi.advanceTimersByTime(180);
    expect(latestWin!.hide).toHaveBeenCalled();
  });

  it('multiple close presses during fade are coalesced (single hide)', () => {
    getCloseActionMock.mockReturnValue('tray');
    createWindow(deps);
    const closeHandler = latestWin!.listeners.get('close')!;
    closeHandler({ preventDefault: vi.fn() });
    closeHandler({ preventDefault: vi.fn() });
    closeHandler({ preventDefault: vi.fn() });
    vi.advanceTimersByTime(180);
    expect(latestWin!.hide).toHaveBeenCalledTimes(1);
  });

  // ─── close-action: quit ────────────────────────────────────────────────
  it('close with pref=quit flips isQuitting and lets default through', () => {
    getCloseActionMock.mockReturnValue('quit');
    createWindow(deps);
    const closeEvt = { preventDefault: vi.fn() };
    latestWin!.listeners.get('close')!(closeEvt);
    expect(deps.setIsQuitting).toHaveBeenCalledWith(true);
    expect(closeEvt.preventDefault).not.toHaveBeenCalled();
    expect(latestWin!.hide).not.toHaveBeenCalled();
  });

  // ─── isQuitting short-circuit ─────────────────────────────────────────
  it('close with isQuitting=true short-circuits with no preventDefault and no hide', () => {
    isQuittingFlag = true;
    getCloseActionMock.mockReturnValue('tray');
    createWindow(deps);
    const closeEvt = { preventDefault: vi.fn() };
    latestWin!.listeners.get('close')!(closeEvt);
    expect(closeEvt.preventDefault).not.toHaveBeenCalled();
    expect(latestWin!.hide).not.toHaveBeenCalled();
    expect(getCloseActionMock).not.toHaveBeenCalled();
  });

  // ─── dev-loop escape hatch ─────────────────────────────────────────────
  it('CCSM_DEV_QUIT_ON_CLOSE=1 bypasses tray and quits even with pref=tray', () => {
    process.env.CCSM_DEV_QUIT_ON_CLOSE = '1';
    getCloseActionMock.mockReturnValue('tray');
    createWindow(deps);
    const closeEvt = { preventDefault: vi.fn() };
    latestWin!.listeners.get('close')!(closeEvt);
    expect(deps.setIsQuitting).toHaveBeenCalledWith(true);
    expect(closeEvt.preventDefault).not.toHaveBeenCalled();
    expect(latestWin!.hide).not.toHaveBeenCalled();
    // Pref is never consulted on this branch.
    expect(getCloseActionMock).not.toHaveBeenCalled();
  });

  // ─── close-action: ask → IPC round-trip ───────────────────────────────
  it('close with pref=ask sends IPC askCloseAction and registers resolve handler', () => {
    getCloseActionMock.mockReturnValue('ask');
    createWindow(deps);
    expect(ipcHandlers.has('window:resolveCloseAction')).toBe(true);
    const closeEvt = { preventDefault: vi.fn() };
    latestWin!.listeners.get('close')!(closeEvt);
    expect(closeEvt.preventDefault).toHaveBeenCalled();
    const sendCall = latestWin!.webContents.send.mock.calls.find(
      (c) => c[0] === 'window:askCloseAction',
    );
    expect(sendCall).toBeDefined();
    const payload = sendCall![1] as { requestId: string; labels: Record<string, string> };
    expect(typeof payload.requestId).toBe('string');
    expect(payload.labels.tray).toBe('close.tray');
  });

  it('ask → renderer chooses tray + dontAskAgain persists tray and hides', () => {
    getCloseActionMock.mockReturnValue('ask');
    createWindow(deps);
    latestWin!.listeners.get('close')!({ preventDefault: vi.fn() });
    const askPayload = latestWin!.webContents.send.mock.calls.find(
      (c) => c[0] === 'window:askCloseAction',
    )![1] as { requestId: string };
    const resolve = ipcHandlers.get('window:resolveCloseAction')!;
    resolve({}, { requestId: askPayload.requestId, choice: 'tray', dontAskAgain: true });
    expect(setCloseActionMock).toHaveBeenCalledWith('tray');
    vi.advanceTimersByTime(180);
    expect(latestWin!.hide).toHaveBeenCalled();
  });

  it('ask → renderer chooses quit triggers app.quit and flips isQuitting', () => {
    getCloseActionMock.mockReturnValue('ask');
    createWindow(deps);
    latestWin!.listeners.get('close')!({ preventDefault: vi.fn() });
    const askPayload = latestWin!.webContents.send.mock.calls.find(
      (c) => c[0] === 'window:askCloseAction',
    )![1] as { requestId: string };
    const resolve = ipcHandlers.get('window:resolveCloseAction')!;
    resolve({}, { requestId: askPayload.requestId, choice: 'quit', dontAskAgain: false });
    expect(deps.setIsQuitting).toHaveBeenCalledWith(true);
    expect(appQuitMock).toHaveBeenCalled();
    expect(setCloseActionMock).not.toHaveBeenCalled();
  });

  it('ask → renderer chooses cancel does nothing destructive', () => {
    getCloseActionMock.mockReturnValue('ask');
    createWindow(deps);
    latestWin!.listeners.get('close')!({ preventDefault: vi.fn() });
    const askPayload = latestWin!.webContents.send.mock.calls.find(
      (c) => c[0] === 'window:askCloseAction',
    )![1] as { requestId: string };
    const resolve = ipcHandlers.get('window:resolveCloseAction')!;
    resolve({}, { requestId: askPayload.requestId, choice: 'cancel', dontAskAgain: true });
    expect(setCloseActionMock).not.toHaveBeenCalled();
    expect(appQuitMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(latestWin!.hide).not.toHaveBeenCalled();
  });

  it('ask → stale resolve with mismatched requestId is ignored', () => {
    getCloseActionMock.mockReturnValue('ask');
    createWindow(deps);
    latestWin!.listeners.get('close')!({ preventDefault: vi.fn() });
    const resolve = ipcHandlers.get('window:resolveCloseAction')!;
    resolve({}, { requestId: 'not-a-real-id', choice: 'quit', dontAskAgain: false });
    expect(deps.setIsQuitting).not.toHaveBeenCalled();
    expect(appQuitMock).not.toHaveBeenCalled();
  });

  it('ask → repeated close presses while ask is in flight do not stack dialogs', () => {
    getCloseActionMock.mockReturnValue('ask');
    createWindow(deps);
    const closeHandler = latestWin!.listeners.get('close')!;
    closeHandler({ preventDefault: vi.fn() });
    closeHandler({ preventDefault: vi.fn() });
    const asks = latestWin!.webContents.send.mock.calls.filter(
      (c) => c[0] === 'window:askCloseAction',
    );
    expect(asks).toHaveLength(1);
  });

  it('ask → renderer never replies; CLOSE_ASK_TIMEOUT_MS triggers tray fallback', () => {
    getCloseActionMock.mockReturnValue('ask');
    createWindow(deps);
    latestWin!.listeners.get('close')!({ preventDefault: vi.fn() });
    expect(latestWin!.hide).not.toHaveBeenCalled();
    vi.advanceTimersByTime(CLOSE_ASK_TIMEOUT_MS);
    // Timeout warns + falls through to fadeThenHide → setTimeout(180).
    expect(warnSpy).toHaveBeenCalled();
    vi.advanceTimersByTime(180);
    expect(latestWin!.hide).toHaveBeenCalled();
    // Timeout path explicitly does NOT persist anything.
    expect(setCloseActionMock).not.toHaveBeenCalled();
  });

  it('ask → renderer destroyed before send falls straight to tray fallback', () => {
    getCloseActionMock.mockReturnValue('ask');
    createWindow(deps);
    latestWin!.webContents.isDestroyed = vi.fn(() => true);
    latestWin!.listeners.get('close')!({ preventDefault: vi.fn() });
    // No askCloseAction send (renderer is gone), straight to fade-then-hide.
    const asks = latestWin!.webContents.send.mock.calls.filter(
      (c) => c[0] === 'window:askCloseAction',
    );
    expect(asks).toHaveLength(0);
    vi.advanceTimersByTime(180);
    expect(latestWin!.hide).toHaveBeenCalled();
  });

  // ─── closed event cleans up the IPC listener ──────────────────────────
  it('closed event removes the resolveCloseAction IPC listener', () => {
    createWindow(deps);
    latestWin!.listeners.get('closed')!();
    expect(removedIpcChannels).toContain('window:resolveCloseAction');
  });

  it('closed event clears any pending ask timer', () => {
    getCloseActionMock.mockReturnValue('ask');
    createWindow(deps);
    latestWin!.listeners.get('close')!({ preventDefault: vi.fn() });
    latestWin!.listeners.get('closed')!();
    // Advancing past the timeout must NOT trigger the tray fallback now.
    vi.advanceTimersByTime(CLOSE_ASK_TIMEOUT_MS + 500);
    expect(latestWin!.hide).not.toHaveBeenCalled();
  });

  // ─── installContextMenu wired up during factory ───────────────────────
  it('factory installs the context-menu listener on webContents', () => {
    createWindow(deps);
    expect(latestWin!.webContentsListeners.has('context-menu')).toBe(true);
  });
});
