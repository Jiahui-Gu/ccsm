// T76 — L8 migration in-progress modal probe.
//
// Spec: docs/superpowers/specs/v0.3-fragments/frag-8-sqlite-migration.md §8.5/§8.6.
// Companion to T75 (failure probe) — drives the success path of the T33
// modal driver:
//
//   hidden ──started──▶ in_progress ──completed──▶ done ──(1s)──▶ hidden
//
// Asserts:
//   1. Modal lands in `in_progress` carrying full started payload after
//      the renderer relays a `migration.started` event over
//      `migration:relayEvent`.
//   2. State pushed over IPC channel `migration:modalState` with the
//      expected `in_progress` shape (so the renderer can render the
//      indeterminate spinner).
//   3. `migration.completed` flips state to `done` (brief flash).
//   4. After the 1s flash window, the modal auto-closes back to `hidden`
//      and the renderer receives the final `hidden` push (modal closes
//      on success, per task contract).
//   5. Reverse-verify: skipping the auto-hide tick keeps the state in
//      `done` — proves the auto-hide assertion isn't passing trivially.
//
// No React render is involved — frag-8 §8.6 modal is a state-machine
// + IPC contract; the renderer-side React component is owned by a
// separate task and is not in scope here. We probe at the IPC boundary
// the renderer subscribes to, mirroring the T75 probe shape.
//
// Run: npx vitest run electron/migration/__tests__/modal-progress-probe.test.tsx

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('electron', () => ({ BrowserWindow: class {} }));

import {
  createModalDriver,
  DEFAULT_DONE_FLASH_MS,
  IPC_CHANNEL_MODAL_STATE,
  IPC_CHANNEL_RELAY_EVENT,
  MIGRATION_EVENT_NAMES,
  type ModalState,
} from '../modal-driver';

// ---------------------------------------------------------------------------

interface StubWin {
  isDestroyed: () => boolean;
  webContents: { isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> };
}
function makeStubWin(): StubWin {
  return {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: vi.fn() },
  };
}

const STARTED_PAYLOAD = {
  event: MIGRATION_EVENT_NAMES.started,
  traceId: 'trace-success',
  sourcePath: 'C:/legacy/ccsm.db',
  fromVersion: 1,
  toVersion: 3,
  startedAt: 1_700_000_000_000,
} as const;

const COMPLETED_PAYLOAD = {
  event: MIGRATION_EVENT_NAMES.completed,
  traceId: 'trace-success',
  fromVersion: 1,
  toVersion: 3,
  durationMs: 320,
  rowsConverted: 42,
} as const;

// ---------------------------------------------------------------------------

describe('T76 migration in-progress modal probe', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the in-progress modal when the daemon emits migration.started', () => {
    const win = makeStubWin();
    const ipcMain = new EventEmitter();
    const driver = createModalDriver({
      getMainWindow: () => win as never,
      ipcMain: ipcMain as never,
    });
    try {
      ipcMain.emit(IPC_CHANNEL_RELAY_EVENT, {} as never, STARTED_PAYLOAD);

      const state = driver.peek();
      expect(state.status).toBe('in_progress');
      if (state.status !== 'in_progress') throw new Error('narrow');
      expect(state.traceId).toBe('trace-success');
      expect(state.sourcePath).toBe('C:/legacy/ccsm.db');
      expect(state.fromVersion).toBe(1);
      expect(state.toVersion).toBe(3);

      // Renderer received exactly one in_progress push on IPC.
      const pushed = win.webContents.send.mock.calls.filter(
        (c) => c[0] === IPC_CHANNEL_MODAL_STATE
      );
      expect(pushed.length).toBe(1);
      expect((pushed[0][1] as ModalState).status).toBe('in_progress');
    } finally {
      driver.dispose();
    }
  });

  it('streams started → completed → done on IPC, then closes (auto-hides) on success', () => {
    const win = makeStubWin();
    const ipcMain = new EventEmitter();
    const driver = createModalDriver({
      getMainWindow: () => win as never,
      ipcMain: ipcMain as never,
    });
    try {
      // Daemon → renderer relay → main, the same path the production
      // daemon-event subscriber takes.
      ipcMain.emit(IPC_CHANNEL_RELAY_EVENT, {} as never, STARTED_PAYLOAD);
      ipcMain.emit(IPC_CHANNEL_RELAY_EVENT, {} as never, COMPLETED_PAYLOAD);

      // Brief done flash before the auto-hide tick.
      expect(driver.peek().status).toBe('done');
      const beforeHide = win.webContents.send.mock.calls.filter(
        (c) => c[0] === IPC_CHANNEL_MODAL_STATE
      );
      expect(beforeHide.length).toBe(2);
      expect((beforeHide[0][1] as ModalState).status).toBe('in_progress');
      expect((beforeHide[1][1] as ModalState).status).toBe('done');
      const donePush = beforeHide[1][1] as ModalState;
      if (donePush.status !== 'done') throw new Error('narrow');
      expect(donePush.durationMs).toBe(320);
      expect(donePush.rowsConverted).toBe(42);

      // Advance past the flash window — modal must close on success.
      vi.advanceTimersByTime(DEFAULT_DONE_FLASH_MS);
      expect(driver.peek().status).toBe('hidden');

      const afterHide = win.webContents.send.mock.calls.filter(
        (c) => c[0] === IPC_CHANNEL_MODAL_STATE
      );
      expect(afterHide.length).toBe(3);
      expect((afterHide[2][1] as ModalState).status).toBe('hidden');
    } finally {
      driver.dispose();
    }
  });

  it('reverse-verify: without the flash-window tick, the modal stays in done (proves auto-hide isn’t passing trivially)', () => {
    const win = makeStubWin();
    const ipcMain = new EventEmitter();
    const driver = createModalDriver({
      getMainWindow: () => win as never,
      ipcMain: ipcMain as never,
    });
    try {
      ipcMain.emit(IPC_CHANNEL_RELAY_EVENT, {} as never, STARTED_PAYLOAD);
      ipcMain.emit(IPC_CHANNEL_RELAY_EVENT, {} as never, COMPLETED_PAYLOAD);

      // Stop one tick short of the flash window — must NOT have closed.
      vi.advanceTimersByTime(DEFAULT_DONE_FLASH_MS - 1);
      expect(driver.peek().status).toBe('done');

      const pushed = win.webContents.send.mock.calls.filter(
        (c) => c[0] === IPC_CHANNEL_MODAL_STATE
      );
      // Only 2 pushes so far — no hidden push yet.
      expect(pushed.length).toBe(2);
      expect((pushed.at(-1)?.[1] as ModalState).status).toBe('done');
    } finally {
      driver.dispose();
    }
  });
});
