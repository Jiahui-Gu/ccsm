// F6 regression — pins the registrar's per-wc `wc.once('destroyed')`
// listener (ipcRegistrar.ts:~200) under the multi-attached scenario.
//
// Existing coverage in `ipcRegistrar.test.ts` exercises the single-wc
// destroy path. The regression risk PR #1315 didn't cover: when multiple
// renderer webContents are attached to the same sid (e.g. main window +
// devtools, or future multi-window), destroying ONE wc must only prune
// THAT wc from `entry.attached` — the closure captured by `once` must
// hold the right wc.id, not a shared/last-bound one.
//
// This test is intentionally separate from `ipcRegistrar.test.ts` per
// the F6 constraint "Do NOT touch any existing tests".

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

interface RegistrarBus {
  resolveClaude: ReturnType<typeof vi.fn>;
  watcherListeners: Map<string, Array<(evt: unknown) => void>>;
  clipboardReadImage: () => { isEmpty: () => boolean; toPNG: () => Buffer };
  userDataDir: string;
}
function bus(): RegistrarBus {
  return (globalThis as any).__irBusF6 as RegistrarBus;
}

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

import { PTY_CHANNELS } from '../../shared/ipcChannels';
import { registerPtyIpc, type PtyIpcDeps } from '../ipcRegistrar';

interface FakeIpcMain {
  handlers: Map<string, (event: unknown, ...args: unknown[]) => unknown>;
  handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => void;
}
function makeFakeIpc(): FakeIpcMain {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  return { handlers, handle: (channel, fn) => { handlers.set(channel, fn); } };
}

interface FakeWebContents {
  id: number;
  isDestroyed: () => boolean;
  send: ReturnType<typeof vi.fn>;
  destroyedHandler?: () => void;
  once: (evt: string, cb: () => void) => void;
}
function makeWc(id: number): FakeWebContents {
  return {
    id,
    isDestroyed: () => false,
    send: vi.fn(),
    once(evt, cb) {
      if (evt === 'destroyed') this.destroyedHandler = cb;
    },
  };
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
  (globalThis as any).__irBusF6 = {
    resolveClaude: vi.fn(),
    watcherListeners: new Map(),
    clipboardReadImage: () => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) }),
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-ipcregistrar-f6-')),
  } satisfies RegistrarBus;
});

afterEach(() => {
  delete (globalThis as any).__irBusF6;
  vi.restoreAllMocks();
});

describe('F6: pty:attach destroyed-handler isolates per-wc (PR #1315 follow-up)', () => {
  it('destroying wcA only removes wcA from entry.attached; wcB stays attached', () => {
    const ipc = makeFakeIpc();
    const attached = new Map<number, unknown>();
    const entry = {
      pty: { pid: 42 },
      serialize: { serialize: () => '' },
      cols: 80,
      rows: 24,
      attached,
    };
    registerPtyIpc(ipc as any, makeDeps({ getEntry: () => entry as any }));

    const wcA = makeWc(101);
    const wcB = makeWc(202);

    // Two distinct webContents attach to the SAME sid.
    ipc.handlers.get(PTY_CHANNELS.attach)!({ sender: wcA }, 'sid');
    ipc.handlers.get(PTY_CHANNELS.attach)!({ sender: wcB }, 'sid');
    expect(attached.has(101)).toBe(true);
    expect(attached.has(202)).toBe(true);
    expect(typeof wcA.destroyedHandler).toBe('function');
    expect(typeof wcB.destroyedHandler).toBe('function');

    // Fire 'destroyed' on wcA only. PIN: the per-wc closure removes ONLY
    // wcA.id (101) — wcB.id (202) is untouched. If the registrar's
    // `wc.once('destroyed')` closure accidentally captured a shared `wc`
    // binding (e.g. via a let in the wrong scope), both ids would be
    // pruned or the wrong one would.
    wcA.destroyedHandler!();
    expect(attached.has(101)).toBe(false);
    expect(attached.has(202)).toBe(true);
    expect(attached.get(202)).toBe(wcB);

    // And destroying wcB later still works (different closure).
    wcB.destroyedHandler!();
    expect(attached.has(202)).toBe(false);
  });
});
