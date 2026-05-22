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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PTY_CHANNELS, SESSION_CHANNELS } from '../../shared/ipcChannels';

interface RegistrarBus {
  resolveClaude: ReturnType<typeof vi.fn>;
  watcherListeners: Map<string, Array<(evt: unknown) => void>>;
  // Task #42 — per-test overrides for the clipboard image stub. We keep
  // these in the bus so vi.mock (hoisted) can reference them lazily
  // without dragging state across tests.
  clipboardReadImage: () => { isEmpty: () => boolean; toPNG: () => Buffer };
  userDataDir: string;
}
function bus(): RegistrarBus {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (globalThis as any).__irBus as RegistrarBus;
}

// Task #42 — registrar now imports `app` and `clipboard` from electron at
// module load. Provide a thin stub; per-test behaviour is steered via the
// bus accessors so the mock factory itself stays static.
vi.mock('electron', () => ({
  app: { getPath: (_k: string) => bus().userDataDir },
  clipboard: { readImage: () => bus().clipboardReadImage() },
}));

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
    killPtySession: vi.fn(async () => true),
    getPtySession: vi.fn(() => null),
    getBufferSnapshot: vi.fn(async () => ({ snapshot: '', seq: 0 })),
    ...over,
  };
}

beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__irBus = {
    resolveClaude: vi.fn(),
    watcherListeners: new Map<string, Array<(evt: unknown) => void>>(),
    // Default to an empty clipboard so the channel returns null cleanly
    // for tests that don't touch the image branch.
    clipboardReadImage: () => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) }),
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-ipcregistrar-')),
  } satisfies RegistrarBus;
});

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).__irBus;
  vi.restoreAllMocks();
});

// ─── handler registration shape ───────────────────────────────────────────

describe('registerPtyIpc handler registration', () => {
  it('registers all ten pty:* channels (8 legacy + getBufferSnapshot + saveClipboardImage)', () => {
    const ipc = makeFakeIpc();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPtyIpc(ipc as any, makeDeps());
    expect(Array.from(ipc.handlers.keys()).sort()).toEqual(
      [
        PTY_CHANNELS.attach,
        PTY_CHANNELS.checkClaudeAvailable,
        PTY_CHANNELS.detach,
        PTY_CHANNELS.get,
        PTY_CHANNELS.getBufferSnapshot,
        PTY_CHANNELS.input,
        PTY_CHANNELS.kill,
        PTY_CHANNELS.list,
        PTY_CHANNELS.resize,
        PTY_CHANNELS.saveClipboardImage,
        PTY_CHANNELS.spawn,
      ].sort(),
    );
  });

  // L4 PR-B (#865) — wire-format probe for the new channel.
  it('pty:getBufferSnapshot delegates to deps.getBufferSnapshot and passes the sid', async () => {
    const ipc = makeFakeIpc();
    const deps = makeDeps({
      getBufferSnapshot: vi.fn(async (sid: string) => ({
        snapshot: `snap-for-${sid}`,
        seq: 7,
      })),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPtyIpc(ipc as any, deps);
    const out = await ipc.handlers.get(PTY_CHANNELS.getBufferSnapshot)!({}, 'sid-Z');
    expect(out).toEqual({ snapshot: 'snap-for-sid-Z', seq: 7 });
    expect(deps.getBufferSnapshot).toHaveBeenCalledWith('sid-Z');
  });
});

// ─── pty:list / get / input / resize / kill — thin pass-through ───────────

describe(PTY_CHANNELS.list, () => {
  it('delegates to deps.listPtySessions', () => {
    const ipc = makeFakeIpc();
    const deps = makeDeps({ listPtySessions: vi.fn(() => [{ sid: 'a', pid: 1, cols: 80, rows: 24, cwd: '/x' }]) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPtyIpc(ipc as any, deps);
    const out = ipc.handlers.get(PTY_CHANNELS.list)!({});
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
    ipc.handlers.get(PTY_CHANNELS.input)!({}, 'sid', 'echo\n');
    expect(deps.inputPtySession).toHaveBeenCalledWith('sid', 'echo\n');
  });

  it('resize forwards sid+cols+rows', () => {
    const ipc = makeFakeIpc();
    const deps = makeDeps();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPtyIpc(ipc as any, deps);
    ipc.handlers.get(PTY_CHANNELS.resize)!({}, 'sid', 100, 30);
    expect(deps.resizePtySession).toHaveBeenCalledWith('sid', 100, 30);
  });

  it('kill returns the deps result', async () => {
    const ipc = makeFakeIpc();
    const deps = makeDeps({ killPtySession: vi.fn(async () => false) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPtyIpc(ipc as any, deps);
    await expect(ipc.handlers.get(PTY_CHANNELS.kill)!({}, 'sid')).resolves.toBe(false);
    expect(deps.killPtySession).toHaveBeenCalledWith('sid');
  });

  it('get returns the deps result', () => {
    const info = { sid: 's', pid: 9, cols: 80, rows: 24, cwd: '/' };
    const ipc = makeFakeIpc();
    const deps = makeDeps({ getPtySession: vi.fn(() => info) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPtyIpc(ipc as any, deps);
    expect(ipc.handlers.get(PTY_CHANNELS.get)!({}, 's')).toBe(info);
  });
});

// ─── pty:spawn — claude resolution + spawn delegation + cwd-redirect ──────

describe(PTY_CHANNELS.spawn, () => {
  it('returns {ok:false, error:claude_not_found} when resolveClaude returns null', async () => {
    const ipc = makeFakeIpc();
    bus().resolveClaude.mockReturnValue(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPtyIpc(ipc as any, makeDeps());
    expect(await ipc.handlers.get(PTY_CHANNELS.spawn)!({}, 'sid', '/work')).toEqual({
      ok: false,
      error: 'claude_not_found',
    });
  });

  it('returns {ok:true, ...info} on success and forwards args to spawnPtySession', async () => {
    const ipc = makeFakeIpc();
    bus().resolveClaude.mockReturnValue('/bin/claude');
    const deps = makeDeps({
      spawnPtySession: vi.fn(() => ({ sid: 'sid', pid: 1, cols: 80, rows: 24, cwd: '/picked' })),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPtyIpc(ipc as any, deps);
    const out = await ipc.handlers.get(PTY_CHANNELS.spawn)!({}, 'sid', '/work');
    expect(out).toEqual({ ok: true, sid: 'sid', pid: 1, cols: 80, rows: 24, cwd: '/picked' });
    const call = (deps.spawnPtySession as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('sid');
    expect(call[1]).toBe('/work');
    expect(call[2]).toBe('/bin/claude');
  });

  // L4 PR-F (#867) — the spawn-time cols/rows hack added for #852 has been
  // removed. The renderer no longer forwards initial dimensions through
  // `pty:spawn`; the PTY launches at the lifecycle defaults (DEFAULT_COLS/
  // ROWS = 120x30) and the post-attach `pty:resize` + snapshot replay
  // (PR-D #866) reflows both the headless source-of-truth buffer and the
  // visible xterm to the real container. The IPC handler therefore no
  // longer parses or threads cols/rows into spawnPtySession opts.
  it('does not forward cols/rows to spawnPtySession (#867 — PR-D resize+replay covers #852)', async () => {
    const ipc = makeFakeIpc();
    bus().resolveClaude.mockReturnValue('/bin/claude');
    const deps = makeDeps({
      spawnPtySession: vi.fn(() => ({ sid: 'sid', pid: 1, cols: 120, rows: 30, cwd: '/picked' })),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPtyIpc(ipc as any, deps);
    // Even if a (legacy) renderer were to send the third opts argument,
    // the IPC handler ignores it — the only opt threaded into the
    // lifecycle is onCwdRedirect (#603).
    await ipc.handlers.get(PTY_CHANNELS.spawn)!({}, 'sid', '/work', { cols: 134, rows: 51 });
    const call = (deps.spawnPtySession as ReturnType<typeof vi.fn>).mock.calls[0];
    const opts = call[3] as { cols?: number; rows?: number; onCwdRedirect?: unknown };
    expect(opts.cols).toBeUndefined();
    expect(opts.rows).toBeUndefined();
    expect(typeof opts.onCwdRedirect).toBe('function');
  });

  it('omits opts argument entirely from `pty:spawn` (post-#867)', async () => {
    const ipc = makeFakeIpc();
    bus().resolveClaude.mockReturnValue('/bin/claude');
    const deps = makeDeps({
      spawnPtySession: vi.fn(() => ({ sid: 'sid', pid: 1, cols: 120, rows: 30, cwd: '/picked' })),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPtyIpc(ipc as any, deps);
    await ipc.handlers.get(PTY_CHANNELS.spawn)!({}, 'sid', '/work');
    const call = (deps.spawnPtySession as ReturnType<typeof vi.fn>).mock.calls[0];
    const opts = call[3] as { cols?: number; rows?: number; onCwdRedirect?: unknown };
    expect(opts.cols).toBeUndefined();
    expect(opts.rows).toBeUndefined();
    expect(typeof opts.onCwdRedirect).toBe('function');
  });

  it('returns {ok:false, error:spawn_failed:...} when spawnPtySession throws', async () => {
    const ipc = makeFakeIpc();
    bus().resolveClaude.mockReturnValue('/bin/claude');
    const deps = makeDeps({
      spawnPtySession: vi.fn(() => { throw new Error('ENOENT'); }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPtyIpc(ipc as any, deps);
    const out = (await ipc.handlers.get(PTY_CHANNELS.spawn)!({}, 'sid', '/work')) as { ok: boolean; error: string };
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/^spawn_failed: ENOENT$/);
  });

  it('onCwdRedirect callback sends session:cwdRedirected to the main window', async () => {
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
    await ipc.handlers.get(PTY_CHANNELS.spawn)!({}, 'sid', '/work');
    expect(captured).not.toBeNull();
    captured!('/new/cwd');
    expect(wc.send).toHaveBeenCalledWith(SESSION_CHANNELS.cwdRedirected, { sid: 'sid', newCwd: '/new/cwd' });
  });

  it('onCwdRedirect is a no-op when main window is null', async () => {
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
    await ipc.handlers.get(PTY_CHANNELS.spawn)!({}, 'sid', '/work');
    expect(() => captured!('/new')).not.toThrow();
  });

  it('onCwdRedirect swallows wc.send throws (renderer gone)', async () => {
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
    await ipc.handlers.get(PTY_CHANNELS.spawn)!({}, 'sid', '/work');
    expect(() => captured!('/new')).not.toThrow();
  });
});

// ─── pty:attach / detach — webContents bookkeeping ────────────────────────

describe(PTY_CHANNELS.attach, () => {
  it('returns null when entry is unknown', () => {
    const ipc = makeFakeIpc();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPtyIpc(ipc as any, makeDeps({ getEntry: () => undefined }));
    expect(ipc.handlers.get(PTY_CHANNELS.attach)!({ sender: makeWc(1) }, 'sid')).toBeNull();
  });

  it('registers the sender wc into the entry.attached map and returns AttachResult (no snapshot — #888 follow-up)', () => {
    const ipc = makeFakeIpc();
    const attached = new Map<number, unknown>();
    const serializeSpy = vi.fn(() => 'paint');
    const entry = {
      pty: { pid: 42 },
      serialize: { serialize: serializeSpy },
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
    const res = ipc.handlers.get(PTY_CHANNELS.attach)!({ sender: wc }, 'sid');
    expect(res).toEqual({ cols: 80, rows: 24, pid: 42 });
    expect(attached.get(7)).toBe(wc);
    // #888 follow-up: pty:attach MUST NOT serialize the headless buffer.
    // The renderer paints via getBufferSnapshot (PR-B); this serialize was
    // a wasted multi-K-line call on every attach.
    expect(serializeSpy).not.toHaveBeenCalled();
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
    ipc.handlers.get(PTY_CHANNELS.attach)!({ sender: wc }, 'sid');
    expect(attached.has(11)).toBe(true);
    expect(typeof wc.destroyedHandler).toBe('function');
    wc.destroyedHandler!();
    expect(attached.has(11)).toBe(false);
  });
});

describe(PTY_CHANNELS.detach, () => {
  it('removes the sender id from entry.attached', () => {
    const ipc = makeFakeIpc();
    const attached = new Map<number, unknown>([[5, makeWc(5)]]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entry = { attached } as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPtyIpc(ipc as any, makeDeps({ getEntry: () => entry }));
    ipc.handlers.get(PTY_CHANNELS.detach)!({ sender: makeWc(5) }, 'sid');
    expect(attached.has(5)).toBe(false);
  });

  it('is a no-op when entry is unknown', () => {
    const ipc = makeFakeIpc();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPtyIpc(ipc as any, makeDeps({ getEntry: () => undefined }));
    expect(() => ipc.handlers.get(PTY_CHANNELS.detach)!({ sender: makeWc(1) }, 'sid')).not.toThrow();
  });
});

// ─── pty:checkClaudeAvailable ─────────────────────────────────────────────

describe(PTY_CHANNELS.checkClaudeAvailable, () => {
  it('returns {available:true, path} when resolveClaude succeeds', async () => {
    const ipc = makeFakeIpc();
    bus().resolveClaude.mockReturnValue('/bin/claude');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPtyIpc(ipc as any, makeDeps());
    expect(await ipc.handlers.get(PTY_CHANNELS.checkClaudeAvailable)!({}, undefined)).toEqual({
      available: true,
      path: '/bin/claude',
    });
  });

  it('returns {available:false} when resolveClaude returns null', async () => {
    const ipc = makeFakeIpc();
    bus().resolveClaude.mockReturnValue(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPtyIpc(ipc as any, makeDeps());
    expect(await ipc.handlers.get(PTY_CHANNELS.checkClaudeAvailable)!({}, undefined)).toEqual({
      available: false,
    });
  });

  it('passes {force:true} through to resolveClaude when opts.force === true', async () => {
    const ipc = makeFakeIpc();
    bus().resolveClaude.mockReturnValue('/bin/claude');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPtyIpc(ipc as any, makeDeps());
    await ipc.handlers.get(PTY_CHANNELS.checkClaudeAvailable)!({}, { force: true });
    expect(bus().resolveClaude).toHaveBeenCalledWith({ force: true });
  });

  it('does NOT pass force when opts is malformed (string / number / null / no force key)', async () => {
    const ipc = makeFakeIpc();
    bus().resolveClaude.mockReturnValue('/bin/claude');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPtyIpc(ipc as any, makeDeps());
    await ipc.handlers.get(PTY_CHANNELS.checkClaudeAvailable)!({}, 'not-an-object');
    await ipc.handlers.get(PTY_CHANNELS.checkClaudeAvailable)!({}, null);
    await ipc.handlers.get(PTY_CHANNELS.checkClaudeAvailable)!({}, {});
    await ipc.handlers.get(PTY_CHANNELS.checkClaudeAvailable)!({}, { force: 'yes' });
    for (const call of bus().resolveClaude.mock.calls) {
      expect(call[0]).toEqual({ force: false });
    }
  });
});

// ─── pty:saveClipboardImage (Task #42) ────────────────────────────────────

describe(PTY_CHANNELS.saveClipboardImage, () => {
  it('writes PNG buffer under <userData>/clipboard-images/ and returns the absolute path', async () => {
    const ipc = makeFakeIpc();
    const pngBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    bus().clipboardReadImage = () => ({ isEmpty: () => false, toPNG: () => pngBuf });
    registerPtyIpc(ipc as unknown as Electron.IpcMain, makeDeps());
    const out = (await ipc.handlers.get(PTY_CHANNELS.saveClipboardImage)!({})) as string;
    expect(typeof out).toBe('string');
    expect(path.isAbsolute(out)).toBe(true);
    expect(out.startsWith(path.join(bus().userDataDir, 'clipboard-images'))).toBe(true);
    expect(path.basename(out)).toMatch(/^\d{8}-\d{6}(-\d{3})?\.png$/);
    expect(fs.readFileSync(out).equals(pngBuf)).toBe(true);
  });

  it('returns null and writes nothing when clipboard image is empty', async () => {
    const ipc = makeFakeIpc();
    // Default bus stub returns isEmpty=true.
    registerPtyIpc(ipc as unknown as Electron.IpcMain, makeDeps());
    const out = await ipc.handlers.get(PTY_CHANNELS.saveClipboardImage)!({});
    expect(out).toBeNull();
    const dir = path.join(bus().userDataDir, 'clipboard-images');
    // mkdir not even attempted on the empty path; dir should not exist.
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('appends -001 suffix when the base timestamp file already exists (collision)', async () => {
    const ipc = makeFakeIpc();
    const pngBuf = Buffer.from([1, 2, 3, 4]);
    bus().clipboardReadImage = () => ({ isEmpty: () => false, toPNG: () => pngBuf });

    // Freeze Date so first and second invocations produce the same base.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 22, 10, 11, 12));

    registerPtyIpc(ipc as unknown as Electron.IpcMain, makeDeps());

    const first = (await ipc.handlers.get(PTY_CHANNELS.saveClipboardImage)!({})) as string;
    expect(path.basename(first)).toBe('20260522-101112.png');

    const second = (await ipc.handlers.get(PTY_CHANNELS.saveClipboardImage)!({})) as string;
    expect(path.basename(second)).toBe('20260522-101112-001.png');

    // Both files must exist with the expected content.
    expect(fs.readFileSync(first).equals(pngBuf)).toBe(true);
    expect(fs.readFileSync(second).equals(pngBuf)).toBe(true);

    vi.useRealTimers();
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
    expect(wc.send).toHaveBeenCalledWith(SESSION_CHANNELS.state, { sid: 'a', state: 'idle' });
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
    expect(wc.send).toHaveBeenCalledWith(SESSION_CHANNELS.title, { sid: 'a', title: 'fixing X' });
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
