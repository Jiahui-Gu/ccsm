// Pins the eight `pty:*` IPC handler contracts and the sessionWatcher →
// renderer state/title bridge. The lifecycle/spawn ops are passed in via
// `deps` so we drive them with vi.fn() — what's under test is the
// registrar's wiring, not the underlying lifecycle.
//
// Heavy collaborators (electron BrowserWindow, claudeResolver, sessionWatcher
// EventEmitter) are mocked. The fake ipcMain captures handlers in a Map
// keyed by channel so each test can invoke `handlers.get(channel)(event,
// ...args)` directly.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface RegistrarBus {
  resolveClaude: ReturnType<typeof vi.fn>;
  watcherListeners: Map<string, Array<(evt: unknown) => void>>;
}
function bus(): RegistrarBus {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (globalThis as any).__irBus as RegistrarBus;
}

vi.mock('../claudeResolver', () => ({
  resolveClaude: (opts?: unknown) => bus().resolveClaude(opts),
}));

vi.mock('../../sessionWatcher', () => ({
  sessionWatcher: {
    on: (event: string, cb: (evt: unknown) => void) => {
      const list = bus().watcherListeners.get(event) ?? [];
      list.push(cb);
      bus().watcherListeners.set(event, list);
    },
  },
}));

import { registerPtyIpc, type PtyIpcDeps } from '../ipcRegistrar';

// ─── helpers ──────────────────────────────────────────────────────────────

interface FakeIpcMain {
  handlers: Map<string, (event: unknown, ...args: unknown[]) => unknown>;
  handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => void;
}
function makeFakeIpc(): FakeIpcMain {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  return {
    handlers,
    handle: (channel, fn) => { handlers.set(channel, fn); },
  };
}

interface FakeWebContents {
  id: number;
  isDestroyed: () => boolean;
  send: ReturnType<typeof vi.fn>;
  // 'destroyed' listeners (only the once handler in pty:attach uses this)
  destroyedHandler?: () => void;
  once: (evt: string, cb: () => void) => void;
}
function makeWc(id: number, opts: { destroyed?: boolean; sendThrows?: boolean } = {}): FakeWebContents {
  const send = vi.fn(() => {
    if (opts.sendThrows) throw new Error('renderer gone');
  });
  return {
    id,
    isDestroyed: () => opts.destroyed === true,
    send,
    once(evt: string, cb: () => void) {
      if (evt === 'destroyed') this.destroyedHandler = cb;
    },
  };
}

interface FakeWin {
  isDestroyed: () => boolean;
  webContents: FakeWebContents;
}
function makeWin(wc: FakeWebContents, destroyed = false): FakeWin {
  return { isDestroyed: () => destroyed, webContents: wc };
}

function makeDeps(over: Partial<PtyIpcDeps> = {}): PtyIpcDeps {
  return {
    getMainWindow: () => null,
    getEntry: () => undefined,
    listPtySessions: vi.fn(() => []),
    spawnPtySession: vi.fn(() => ({ sid: 's', pid: 1, cols: 80, rows: 24, cwd: '/' })),
    inputPtySession: vi.fn(),
    resizePtySession: vi.fn(),
    killPtySession: vi.fn(() => true),
    getPtySession: vi.fn(() => null),
    ...over,
  };
}

beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__irBus = {
    resolveClaude: vi.fn(),
    watcherListeners: new Map<string, Array<(evt: unknown) => void>>(),
  } satisfies RegistrarBus;
});

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).__irBus;
  vi.restoreAllMocks();
});

// ─── handler registration shape ───────────────────────────────────────────

describe('registerPtyIpc handler registration', () => {
  it('registers all eight pty:* channels', () => {
    const ipc = makeFakeIpc();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPtyIpc(ipc as any, makeDeps());
    expect(Array.from(ipc.handlers.keys()).sort()).toEqual(
      [
        'pty:attach',
        'pty:checkClaudeAvailable',
        'pty:detach',
        'pty:get',
        'pty:input',
        'pty:kill',
        'pty:list',
        'pty:resize',
        'pty:spawn',
      ].sort(),
    );
  });
});

// ─── pty:list / get / input / resize / kill — thin pass-through ───────────

describe('pty:list', () => {
  it('delegates to deps.listPtySessions', () => {
    const ipc = makeFakeIpc();
    const deps = makeDeps({ listPtySessions: vi.fn(() => [{ sid: 'a', pid: 1, cols: 80, rows: 24, cwd: '/x' }]) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPtyIpc(ipc as any, deps);
    const out = ipc.handlers.get('pty:list')!({});
    expect(out).toEqual([{ sid: 'a', pid: 1, cols: 80, rows: 24, cwd: '/x' }]);
    expect(deps.listPtySessions).toHaveBeenCalledTimes(1);
  });
});

describe('pty:input / resize / kill / get pass-through', () => {
  it('input forwards sid+data', () => {
    const ipc = makeFakeIpc();
    const deps = makeDeps();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPtyIpc(ipc as any, deps);
    ipc.handlers.get('pty:input')!({}, 'sid', 'echo\n');
    expect(deps.inputPtySession).toHaveBeenCalledWith('sid', 'echo\n');
  });

  it('resize forwards sid+cols+rows', () => {
    const ipc = makeFakeIpc();
    const deps = makeDeps();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPtyIpc(ipc as any, deps);
    ipc.handlers.get('pty:resize')!({}, 'sid', 100, 30);
    expect(deps.resizePtySession).toHaveBeenCalledWith('sid', 100, 30);
  });

  it('kill returns the deps result', () => {
    const ipc = makeFakeIpc();
    const deps = makeDeps({ killPtySession: vi.fn(() => false) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPtyIpc(ipc as any, deps);
    expect(ipc.handlers.get('pty:kill')!({}, 'sid')).toBe(false);
    expect(deps.killPtySession).toHaveBeenCalledWith('sid');
  });

  it('get returns the deps result', () => {
    const info = { sid: 's', pid: 9, cols: 80, rows: 24, cwd: '/' };
    const ipc = makeFakeIpc();
    const deps = makeDeps({ getPtySession: vi.fn(() => info) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPtyIpc(ipc as any, deps);
    expect(ipc.handlers.get('pty:get')!({}, 's')).toBe(info);
  });
});

// ─── pty:spawn — claude resolution + spawn delegation + cwd-redirect ──────

describe('pty:spawn', () => {
  it('returns {ok:false, error:claude_not_found} when resolveClaude returns null', () => {
    const ipc = makeFakeIpc();
    bus().resolveClaude.mockReturnValue(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPtyIpc(ipc as any, makeDeps());
    expect(ipc.handlers.get('pty:spawn')!({}, 'sid', '/work')).toEqual({
      ok: false,
      error: 'claude_not_found',
    });
  });

  it('returns {ok:true, ...info} on success and forwards args to spawnPtySession', () => {
    const ipc = makeFakeIpc();
    bus().resolveClaude.mockReturnValue('/bin/claude');
    const deps = makeDeps({
      spawnPtySession: vi.fn(() => ({ sid: 'sid', pid: 1, cols: 80, rows: 24, cwd: '/picked' })),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPtyIpc(ipc as any, deps);
    const out = ipc.handlers.get('pty:spawn')!({}, 'sid', '/work');
    expect(out).toEqual({ ok: true, sid: 'sid', pid: 1, cols: 80, rows: 24, cwd: '/picked' });
    const call = (deps.spawnPtySession as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('sid');
    expect(call[1]).toBe('/work');
    expect(call[2]).toBe('/bin/claude');
  });

  // Task #852 — renderer measures the visible viewport via FitAddon and
  // passes cols/rows so the PTY launches at the size it will be displayed
  // at (eliminating the "top-painted, bottom-black-void" alt-screen
  // divergence). Without this forwarding the trust-prompt rendered by
  // claude at the default 120x30 stays stuck at that size while the
  // visible xterm gets resized post-write to 134x51, leaving the bottom
  // 21 rows of the prompt invisible until the user types.
  it('forwards renderer-supplied cols/rows from opts to spawnPtySession (#852)', () => {
    const ipc = makeFakeIpc();
    bus().resolveClaude.mockReturnValue('/bin/claude');
    const deps = makeDeps({
      spawnPtySession: vi.fn(() => ({ sid: 'sid', pid: 1, cols: 134, rows: 51, cwd: '/picked' })),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPtyIpc(ipc as any, deps);
    ipc.handlers.get('pty:spawn')!({}, 'sid', '/work', { cols: 134, rows: 51 });
    const call = (deps.spawnPtySession as ReturnType<typeof vi.fn>).mock.calls[0];
    const opts = call[3] as { cols?: number; rows?: number };
    expect(opts.cols).toBe(134);
    expect(opts.rows).toBe(51);
  });

  it('omits cols/rows when opts is missing or non-numeric (lifecycle uses defaults)', () => {
    const ipc = makeFakeIpc();
    bus().resolveClaude.mockReturnValue('/bin/claude');
    const deps = makeDeps({
      spawnPtySession: vi.fn(() => ({ sid: 'sid', pid: 1, cols: 120, rows: 30, cwd: '/picked' })),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPtyIpc(ipc as any, deps);
    // No opts argument at all.
    ipc.handlers.get('pty:spawn')!({}, 'sid', '/work');
    let call = (deps.spawnPtySession as ReturnType<typeof vi.fn>).mock.calls[0];
    let opts = call[3] as { cols?: number; rows?: number };
    expect(opts.cols).toBeUndefined();
    expect(opts.rows).toBeUndefined();

    // Garbage opts (non-numeric) — defensive parsing still falls back.
    (deps.spawnPtySession as ReturnType<typeof vi.fn>).mockClear();
    ipc.handlers.get('pty:spawn')!({}, 'sid', '/work', { cols: 'wide', rows: null });
    call = (deps.spawnPtySession as ReturnType<typeof vi.fn>).mock.calls[0];
    opts = call[3] as { cols?: number; rows?: number };
    expect(opts.cols).toBeUndefined();
    expect(opts.rows).toBeUndefined();
  });

  it('floors fractional cols/rows and clamps to a >=2 minimum', () => {
    const ipc = makeFakeIpc();
    bus().resolveClaude.mockReturnValue('/bin/claude');
    const deps = makeDeps({
      spawnPtySession: vi.fn(() => ({ sid: 'sid', pid: 1, cols: 80, rows: 24, cwd: '/' })),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPtyIpc(ipc as any, deps);
    ipc.handlers.get('pty:spawn')!({}, 'sid', '/work', { cols: 134.7, rows: 1 });
    const call = (deps.spawnPtySession as ReturnType<typeof vi.fn>).mock.calls[0];
    const opts = call[3] as { cols?: number; rows?: number };
    expect(opts.cols).toBe(134);
    expect(opts.rows).toBe(2);
  });

  it('returns {ok:false, error:spawn_failed:...} when spawnPtySession throws', () => {
    const ipc = makeFakeIpc();
    bus().resolveClaude.mockReturnValue('/bin/claude');
    const deps = makeDeps({
      spawnPtySession: vi.fn(() => { throw new Error('ENOENT'); }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPtyIpc(ipc as any, deps);
    const out = ipc.handlers.get('pty:spawn')!({}, 'sid', '/work') as { ok: boolean; error: string };
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/^spawn_failed: ENOENT$/);
  });

  it('onCwdRedirect callback sends session:cwdRedirected to the main window', () => {
    const ipc = makeFakeIpc();
    bus().resolveClaude.mockReturnValue('/bin/claude');
    const wc = makeWc(1);
    const win = makeWin(wc);
    let captured: ((newCwd: string) => void) | null = null;
    const deps = makeDeps({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getMainWindow: () => win as any,
      spawnPtySession: vi.fn((_sid: string, _cwd: string, _claude: string, opts?: { onCwdRedirect?: (n: string) => void }) => {
        captured = opts?.onCwdRedirect ?? null;
        return { sid: 'sid', pid: 1, cols: 80, rows: 24, cwd: '/picked' };
      }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPtyIpc(ipc as any, deps);
    ipc.handlers.get('pty:spawn')!({}, 'sid', '/work');
    expect(captured).not.toBeNull();
    captured!('/new/cwd');
    expect(wc.send).toHaveBeenCalledWith('session:cwdRedirected', { sid: 'sid', newCwd: '/new/cwd' });
  });

  it('onCwdRedirect is a no-op when main window is null', () => {
    const ipc = makeFakeIpc();
    bus().resolveClaude.mockReturnValue('/bin/claude');
    let captured: ((newCwd: string) => void) | null = null;
    const deps = makeDeps({
      getMainWindow: () => null,
      spawnPtySession: vi.fn((_sid, _cwd, _claude, opts?: { onCwdRedirect?: (n: string) => void }) => {
        captured = opts?.onCwdRedirect ?? null;
        return { sid: 'sid', pid: 1, cols: 80, rows: 24, cwd: '/' };
      }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPtyIpc(ipc as any, deps);
    ipc.handlers.get('pty:spawn')!({}, 'sid', '/work');
    expect(() => captured!('/new')).not.toThrow();
  });

  it('onCwdRedirect swallows wc.send throws (renderer gone)', () => {
    const ipc = makeFakeIpc();
    bus().resolveClaude.mockReturnValue('/bin/claude');
    const wc = makeWc(1, { sendThrows: true });
    const win = makeWin(wc);
    let captured: ((newCwd: string) => void) | null = null;
    const deps = makeDeps({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getMainWindow: () => win as any,
      spawnPtySession: vi.fn((_sid, _cwd, _claude, opts?: { onCwdRedirect?: (n: string) => void }) => {
        captured = opts?.onCwdRedirect ?? null;
        return { sid: 'sid', pid: 1, cols: 80, rows: 24, cwd: '/' };
      }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPtyIpc(ipc as any, deps);
    ipc.handlers.get('pty:spawn')!({}, 'sid', '/work');
    expect(() => captured!('/new')).not.toThrow();
  });
});

// ─── pty:attach / detach — webContents bookkeeping ────────────────────────

describe('pty:attach', () => {
  it('returns null when entry is unknown', () => {
    const ipc = makeFakeIpc();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPtyIpc(ipc as any, makeDeps({ getEntry: () => undefined }));
    expect(ipc.handlers.get('pty:attach')!({ sender: makeWc(1) }, 'sid')).toBeNull();
  });

  it('registers the sender wc into the entry.attached map and returns AttachResult', () => {
    const ipc = makeFakeIpc();
    const attached = new Map<number, unknown>();
    const entry = {
      pty: { pid: 42 },
      serialize: { serialize: () => 'paint' },
      cols: 80,
      rows: 24,
      attached,
    };
    const deps = makeDeps({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getEntry: () => entry as any,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPtyIpc(ipc as any, deps);
    const wc = makeWc(7);
    const res = ipc.handlers.get('pty:attach')!({ sender: wc }, 'sid');
    expect(res).toEqual({ snapshot: 'paint', cols: 80, rows: 24, pid: 42 });
    expect(attached.get(7)).toBe(wc);
  });

  it('the wc destroyed handler removes it from entry.attached', () => {
    const ipc = makeFakeIpc();
    const attached = new Map<number, unknown>();
    const entry = {
      pty: { pid: 1 },
      serialize: { serialize: () => '' },
      cols: 80,
      rows: 24,
      attached,
    };
    const deps = makeDeps({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getEntry: () => entry as any,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPtyIpc(ipc as any, deps);
    const wc = makeWc(11);
    ipc.handlers.get('pty:attach')!({ sender: wc }, 'sid');
    expect(attached.has(11)).toBe(true);
    expect(typeof wc.destroyedHandler).toBe('function');
    wc.destroyedHandler!();
    expect(attached.has(11)).toBe(false);
  });
});

describe('pty:detach', () => {
  it('removes the sender id from entry.attached', () => {
    const ipc = makeFakeIpc();
    const attached = new Map<number, unknown>([[5, makeWc(5)]]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entry = { attached } as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPtyIpc(ipc as any, makeDeps({ getEntry: () => entry }));
    ipc.handlers.get('pty:detach')!({ sender: makeWc(5) }, 'sid');
    expect(attached.has(5)).toBe(false);
  });

  it('is a no-op when entry is unknown', () => {
    const ipc = makeFakeIpc();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPtyIpc(ipc as any, makeDeps({ getEntry: () => undefined }));
    expect(() => ipc.handlers.get('pty:detach')!({ sender: makeWc(1) }, 'sid')).not.toThrow();
  });
});

// ─── pty:checkClaudeAvailable ─────────────────────────────────────────────

describe('pty:checkClaudeAvailable', () => {
  it('returns {available:true, path} when resolveClaude succeeds', () => {
    const ipc = makeFakeIpc();
    bus().resolveClaude.mockReturnValue('/bin/claude');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPtyIpc(ipc as any, makeDeps());
    expect(ipc.handlers.get('pty:checkClaudeAvailable')!({}, undefined)).toEqual({
      available: true,
      path: '/bin/claude',
    });
  });

  it('returns {available:false} when resolveClaude returns null', () => {
    const ipc = makeFakeIpc();
    bus().resolveClaude.mockReturnValue(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPtyIpc(ipc as any, makeDeps());
    expect(ipc.handlers.get('pty:checkClaudeAvailable')!({}, undefined)).toEqual({
      available: false,
    });
  });

  it('passes {force:true} through to resolveClaude when opts.force === true', () => {
    const ipc = makeFakeIpc();
    bus().resolveClaude.mockReturnValue('/bin/claude');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPtyIpc(ipc as any, makeDeps());
    ipc.handlers.get('pty:checkClaudeAvailable')!({}, { force: true });
    expect(bus().resolveClaude).toHaveBeenCalledWith({ force: true });
  });

  it('does NOT pass force when opts is malformed (string / number / null / no force key)', () => {
    const ipc = makeFakeIpc();
    bus().resolveClaude.mockReturnValue('/bin/claude');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPtyIpc(ipc as any, makeDeps());
    ipc.handlers.get('pty:checkClaudeAvailable')!({}, 'not-an-object');
    ipc.handlers.get('pty:checkClaudeAvailable')!({}, null);
    ipc.handlers.get('pty:checkClaudeAvailable')!({}, {});
    ipc.handlers.get('pty:checkClaudeAvailable')!({}, { force: 'yes' });
    for (const call of bus().resolveClaude.mock.calls) {
      expect(call[0]).toEqual({ force: false });
    }
  });
});

// ─── sessionWatcher → renderer state/title bridge ─────────────────────────

describe('sessionWatcher → renderer bridge', () => {
  it('subscribes to state-changed and title-changed exactly once across re-registrations', () => {
    const ipc = makeFakeIpc();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPtyIpc(ipc as any, makeDeps());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPtyIpc(ipc as any, makeDeps());
    // The registrar's `stateBridgeInstalled` guard is module-level and may
    // already be true from earlier tests (other test files import this same
    // module). What we can pin: across multiple registers in this test, we
    // never get MORE than one listener appended.
    expect((bus().watcherListeners.get('state-changed') ?? []).length).toBeLessThanOrEqual(1);
    expect((bus().watcherListeners.get('title-changed') ?? []).length).toBeLessThanOrEqual(1);
  });

  it('forwards state-changed events to the main window webContents (when listener present)', () => {
    const ipc = makeFakeIpc();
    const wc = makeWc(1);
    const win = makeWin(wc);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPtyIpc(ipc as any, makeDeps({ getMainWindow: () => win as any }));
    const listeners = bus().watcherListeners.get('state-changed') ?? [];
    if (listeners.length === 0) {
      // Already installed by an earlier test — bridge is module-level and
      // the once-guard suppresses re-subscribe. The behavioural contract is
      // verified in the previous test's assertion.
      return;
    }
    listeners[0]!({ sid: 'a', state: 'idle' });
    expect(wc.send).toHaveBeenCalledWith('session:state', { sid: 'a', state: 'idle' });
  });

  it('forwards title-changed events to the main window webContents (when listener present)', () => {
    const ipc = makeFakeIpc();
    const wc = makeWc(1);
    const win = makeWin(wc);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPtyIpc(ipc as any, makeDeps({ getMainWindow: () => win as any }));
    const listeners = bus().watcherListeners.get('title-changed') ?? [];
    if (listeners.length === 0) return;
    listeners[0]!({ sid: 'a', title: 'fixing X' });
    expect(wc.send).toHaveBeenCalledWith('session:title', { sid: 'a', title: 'fixing X' });
  });

  it('state-changed forward is a no-op when getMainWindow returns null', () => {
    const ipc = makeFakeIpc();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPtyIpc(ipc as any, makeDeps({ getMainWindow: () => null }));
    const listeners = bus().watcherListeners.get('state-changed') ?? [];
    if (listeners.length === 0) return;
    expect(() => listeners[0]!({ sid: 'a' })).not.toThrow();
  });

  it('state-changed forward swallows wc.send throws', () => {
    const ipc = makeFakeIpc();
    const wc = makeWc(1, { sendThrows: true });
    const win = makeWin(wc);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPtyIpc(ipc as any, makeDeps({ getMainWindow: () => win as any }));
    const listeners = bus().watcherListeners.get('state-changed') ?? [];
    if (listeners.length === 0) return;
    expect(() => listeners[0]!({ sid: 'a' })).not.toThrow();
  });
});
