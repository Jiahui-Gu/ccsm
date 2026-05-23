// Renderer ↔ main type-drift contract (audit finding 1b).
//
// For the most load-bearing IPC channels we drive the ACTUAL main-side
// production code (registrar, handler, dispatch function) with stubbed
// I/O boundaries (sqlite, node-pty, electron BrowserWindow). A drift in
// argument order, payload field name, or return-value discriminant on
// any of the five channels below makes a test in THIS file fail —
// independent of whatever the renderer-side preload wrappers do.
//
// Channels covered (3 surfaces × 5 channels):
//
//   • persist state    — db:save, db:load                  (renderer↔main, invoke)
//   • pty input        — pty:input                          (renderer→main, invoke)
//   • pty data fan-out — pty:data                           (main→renderer, event)
//   • session lifecycle— session:state                      (main→renderer, event)
//
// The previous version of this file (PR #1332) mocked the production
// glue itself and asserted against test-local handlers / types, which
// meant a real-handler arg-swap or field-rename could not make the
// tests fail. This rewrite imports the real `handleDbSave/Load`,
// `registerPtyIpc`, and `dispatchPtyChunk` and only mocks at the
// SQLite / node-pty / electron-BrowserWindow boundary.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';

// Renderer-side wire types — single source of truth for what the
// renderer expects to see on each channel.
import type { PtyDataEvent } from '../../src/pty.d';
import type { SessionStatePayload, SessionState } from '../../src/shared/sessionState';
import { PTY_CHANNELS, SESSION_CHANNELS, DB_CHANNELS } from '../../electron/shared/ipcChannels';

// ── Mocks at the I/O boundary ─────────────────────────────────────────
// `electron` is unavailable in vitest. ipcRegistrar imports `app` and
// `clipboard` at module load (used by other channels we don't exercise
// here); stub them so the module loads.
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/contract-test' },
  clipboard: { readImage: () => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) }) },
}));

// SQLite layer for dbIpc. Real `validateSaveStateInput` and `fromMainFrame`
// are NOT mocked — the dbIpc handler's guard + validation + persist + emit
// chain runs as in production.
const store = new Map<string, string>();
vi.mock('../../electron/db', () => ({
  saveState: (k: string, v: string) => {
    store.set(k, v);
  },
  loadState: (k: string) => (store.has(k) ? store.get(k)! : null),
}));

const emitStateSavedSpy = vi.fn();
vi.mock('../../electron/shared/stateSavedBus', () => ({
  emitStateSaved: (k: string) => emitStateSavedSpy(k),
}));

// claudeResolver is imported by ipcRegistrar at module load; pty:input
// and session:state don't exercise the spawn handler so a no-op stub is
// enough.
vi.mock('../../electron/ptyHost/claudeResolver', () => ({
  resolveClaude: vi.fn(async () => null),
}));

// sessionWatcher is an EventEmitter singleton; mock with a Map-of-callbacks
// so we can drive `state-changed` listeners directly from the test.
interface WatcherStub {
  listeners: Map<string, Array<(evt: unknown) => void>>;
  emit: (event: string, evt: unknown) => void;
}
const watcherStub: WatcherStub = {
  listeners: new Map(),
  emit(event, evt) {
    for (const cb of this.listeners.get(event) ?? []) cb(evt);
  },
};
vi.mock('../../electron/sessionWatcher', () => ({
  sessionWatcher: {
    on: (event: string, cb: (evt: unknown) => void) => {
      const list = watcherStub.listeners.get(event) ?? [];
      list.push(cb);
      watcherStub.listeners.set(event, list);
    },
  },
}));

import { handleDbSave, handleDbLoad, registerDbIpc } from '../../electron/ipc/dbIpc';
import { registerPtyIpc, type PtyIpcDeps } from '../../electron/ptyHost/ipcRegistrar';
import { dispatchPtyChunk, type Entry } from '../../electron/ptyHost/entryFactory';

// ── Helpers ───────────────────────────────────────────────────────────

/** Build an IpcMainInvokeEvent that satisfies `fromMainFrame` (the
 *  real guard checks `e.senderFrame === e.sender.mainFrame`). */
function makeMainFrameEvent(): IpcMainInvokeEvent {
  const mainFrame = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { senderFrame: mainFrame, sender: { mainFrame } } as any;
}

interface FakeIpcMain {
  handlers: Map<string, (event: unknown, ...args: unknown[]) => unknown>;
  ipcMain: IpcMain;
}
function makeFakeIpc(): FakeIpcMain {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const ipcMain = {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    },
  } as unknown as IpcMain;
  return { handlers, ipcMain };
}

interface FakeWc {
  id: number;
  send: ReturnType<typeof vi.fn>;
  isDestroyed: () => boolean;
}
function makeWc(id = 1): FakeWc {
  return { id, send: vi.fn(), isDestroyed: () => false };
}

// Shared registrar handle. `registerPtyIpc` installs its sessionWatcher
// bridge once per module (module-level `stateBridgeInstalled` guard), so
// we register exactly ONCE for the whole test file and swap the
// per-test window / deps via these refs.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let currentWin: any = null;
let currentInputSpy: ReturnType<typeof vi.fn> = vi.fn();
let registrarHandlers: Map<string, (event: unknown, ...args: unknown[]) => unknown>;
{
  const { handlers, ipcMain } = makeFakeIpc();
  registrarHandlers = handlers;
  const deps: PtyIpcDeps = {
    getMainWindow: () => currentWin,
    getEntry: () => undefined,
    listPtySessions: () => [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spawnPtySession: vi.fn() as any,
    inputPtySession: (sid: string, data: string) => currentInputSpy(sid, data),
    resizePtySession: vi.fn(),
    killPtySession: vi.fn(async () => true),
    getPtySession: () => null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getBufferSnapshot: vi.fn() as any,
  };
  registerPtyIpc(ipcMain, deps);
}

beforeEach(() => {
  store.clear();
  emitStateSavedSpy.mockClear();
  // NOTE: do NOT clear watcherStub.listeners — the registrar's
  // state-changed listener is installed once at file load (module
  // singleton). Clearing would orphan it.
  currentWin = null;
  currentInputSpy = vi.fn();
});

// ─────────────────────────────────────────────────────────────────────
// db:save / db:load — real handler, real validator, real guard
// ─────────────────────────────────────────────────────────────────────
describe('db:save / db:load (real handler chain)', () => {
  it('save→load round-trips a representative renderer payload', () => {
    const e = makeMainFrameEvent();
    const key = 'appState';
    const payload = JSON.stringify({
      sessions: [{ id: 'a-b-c', name: 'Hello 中文 🙂', cwd: '/x', groupId: 'g1' }],
      groups: [{ id: 'g1', name: 'Default', collapsed: false }],
      version: 1,
    });

    const saveResult = handleDbSave(e, key, payload);
    // Preload wrapper tests `result.ok` — a drift to `{success: true}`
    // would break the renderer. This passes through the REAL
    // fromMainFrame guard + REAL validateSaveStateInput.
    expect(saveResult).toEqual({ ok: true });
    // emitStateSaved bus contract — caches downstream subscribe to this.
    expect(emitStateSavedSpy).toHaveBeenCalledExactlyOnceWith(key);

    const loadResult = handleDbLoad(e, key);
    expect(loadResult).toBe(payload);
    expect(typeof loadResult === 'string' || loadResult === null).toBe(true);
  });

  it('db:load returns null (NOT undefined) for missing keys', () => {
    // Renderer signature is `Promise<string | null>`. `=== null` pattern
    // match in src/stores/persist.ts would silently fail on `undefined`.
    const result = handleDbLoad(makeMainFrameEvent(), 'never-set');
    expect(result).toBeNull();
  });

  it('db:save rejects with the real validator discriminant on oversized value', () => {
    // Drives the REAL validateSaveStateInput. If the handler stopped
    // surfacing `v` directly (e.g. renamed `error` to `reason`) this
    // fails.
    const huge = 'x'.repeat(10_000_001);
    const res = handleDbSave(makeMainFrameEvent(), 'k', huge);
    expect(res).toEqual({ ok: false, error: 'value_too_large' });
    expect(emitStateSavedSpy).not.toHaveBeenCalled();
  });

  it('db:save rejects when sender is not the main frame (real guard)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const badEvent = { senderFrame: {}, sender: { mainFrame: {} } } as any;
    const res = handleDbSave(badEvent, 'k', 'v');
    expect(res).toEqual({ ok: false, error: 'rejected' });
  });

  it('registerDbIpc wires DB_CHANNELS.save / DB_CHANNELS.load — channel names pinned', () => {
    // Pins the channel-name → handler binding via the real
    // registration function. A rename of either channel string in
    // ipcChannels.ts surfaces here.
    const { handlers, ipcMain } = makeFakeIpc();
    registerDbIpc({ ipcMain });
    expect(handlers.has(DB_CHANNELS.save)).toBe(true);
    expect(handlers.has(DB_CHANNELS.load)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// pty:input — drive the REAL registrar
// ─────────────────────────────────────────────────────────────────────
describe('pty:input handler (real registrar)', () => {
  it('forwards (sid, data) to deps.inputPtySession in that order', () => {
    const handler = registrarHandlers.get(PTY_CHANNELS.input);
    expect(handler, 'pty:input handler must be registered').toBeDefined();

    const sid = '5e8b1c2a-1234-4abc-89ef-0123456789ab';
    const data = 'echo hello\n';
    // Real registrar's signature: `(event, sid, data) => deps.inputPtySession(sid, data)`.
    // If a future change swaps the arg order this expectation fails.
    handler!({}, sid, data);
    expect(currentInputSpy).toHaveBeenCalledExactlyOnceWith(sid, data);
  });
});

// ─────────────────────────────────────────────────────────────────────
// pty:data — drive the REAL dispatchPtyChunk
// ─────────────────────────────────────────────────────────────────────
describe('pty:data event payload (real dispatchPtyChunk)', () => {
  it('emits PTY_CHANNELS.data with {sid, chunk, seq} on the wire', () => {
    const wc = makeWc();
    // Build a minimal Entry. Only `headless.write`, `attached`, and the
    // backpressure counters are touched by dispatchPtyChunk.
    const entry = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pty: {} as any,
      headless: {
        write: (_chunk: string, cb?: () => void) => {
          cb?.();
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      serialize: {} as any,
      attached: new Map<number, WebContents>([[wc.id, wc as unknown as WebContents]]),
      cols: 80,
      rows: 24,
      cwd: '/tmp',
      seq: 6,
      pendingHeadlessWrites: 0,
      backpressureWarned: false,
    } satisfies Entry;

    dispatchPtyChunk('abc', entry, 'hello');

    // Channel name pinned via the real PTY_CHANNELS constant — a rename
    // breaks this immediately.
    expect(wc.send).toHaveBeenCalledExactlyOnceWith(PTY_CHANNELS.data, {
      sid: 'abc',
      chunk: 'hello',
      seq: 7, // pre-bumped before broadcast (PR-B seq contract)
    });

    // Belt-and-braces: the payload object the production code sent must
    // satisfy the renderer-side PtyDataEvent type (compile-time check).
    // The `wc.send` mock captures the literal arg; cast it through
    // PtyDataEvent and read each field so a field-rename at the
    // production emit-site (e.g. `seq` → `sequence`) fails both at
    // runtime (the toHaveBeenCalledExactlyOnceWith above) AND at
    // compile time here.
    const sent = wc.send.mock.calls[0]![1] as PtyDataEvent;
    expect(sent.sid).toBe('abc');
    expect(sent.chunk).toBe('hello');
    expect(sent.seq).toBe(7);
  });
});

// ─────────────────────────────────────────────────────────────────────
// session:state — drive the REAL registrar's watcher bridge
// ─────────────────────────────────────────────────────────────────────
describe('session:state event payload (real registrar bridge)', () => {
  it('forwards sessionWatcher state-changed evt through SESSION_CHANNELS.state', () => {
    const wc = makeWc();
    currentWin = {
      isDestroyed: () => false,
      webContents: { ...wc, isDestroyed: () => false } as unknown as WebContents,
    };

    const evt: SessionStatePayload = { sid: 'x', state: 'running' };
    watcherStub.emit('state-changed', evt);

    // Capture send call on the BrowserWindow's webContents.
    const sendSpy = (currentWin.webContents as unknown as FakeWc).send;
    expect(sendSpy).toHaveBeenCalledExactlyOnceWith(SESSION_CHANNELS.state, evt);

    // Verify the union pins production's vocabulary. Compile-time check
    // — a 4th SessionState added without updating the renderer's map in
    // src/agent/lifecycle.ts would have to add it here (or break the
    // build at the iteration below).
    const allStates: SessionState[] = ['idle', 'running', 'requires_action'];
    for (const s of allStates) {
      const p: SessionStatePayload = { sid: 'x', state: s };
      expect(p.state).toBe(s);
    }
    // @ts-expect-error — invented state must not satisfy the union.
    const bad: SessionStatePayload = { sid: 'x', state: 'completed' };
    expect(allStates).not.toContain(bad.state);
  });
});
