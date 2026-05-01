// Hermetic tests for the migration modal driver (T33).
//
// Coverage:
//   - Pure decider `reduce`: every state × event transition incl. no-ops.
//   - Driver wiring: IPC send fires on transitions, `done` auto-hide
//     timer, `failed` sticky-until-dismiss, dispose cleans up timers
//     and listeners.
//   - IPC payload parser: structurally invalid events are dropped.
//   - Wire-contract parity: event-name constants match the daemon-side
//     T30 source-of-truth file.
//   - Reverse-verify: each invariant is re-checked after a counter-
//     scenario to guard against the test passing for trivial reasons.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';

// `electron` is a runtime-only dep in main; mock it so the test runs in
// plain node. We only use `BrowserWindow` as a type here; the real type
// shape is satisfied by our stub.
vi.mock('electron', () => ({
  BrowserWindow: class {},
}));

import {
  reduce,
  createModalDriver,
  HIDDEN_STATE,
  DEFAULT_DONE_FLASH_MS,
  IPC_CHANNEL_MODAL_STATE,
  IPC_CHANNEL_RELAY_EVENT,
  IPC_CHANNEL_DISMISS,
  MIGRATION_EVENT_NAMES,
  type ModalState,
  type MigrationEvent,
  type MigrationStartedEvent,
  type MigrationCompletedEvent,
  type MigrationFailedEvent,
  __testing,
} from '../modal-driver';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function startedEvent(over: Partial<MigrationStartedEvent> = {}): MigrationStartedEvent {
  return {
    event: MIGRATION_EVENT_NAMES.started,
    traceId: 'trace-1',
    sourcePath: 'C:/legacy/ccsm.db',
    fromVersion: 1,
    toVersion: 3,
    startedAt: 1_700_000_000_000,
    ...over,
  };
}

function completedEvent(
  over: Partial<MigrationCompletedEvent> = {}
): MigrationCompletedEvent {
  return {
    event: MIGRATION_EVENT_NAMES.completed,
    traceId: 'trace-1',
    fromVersion: 1,
    toVersion: 3,
    durationMs: 320,
    rowsConverted: 42,
    ...over,
  };
}

function failedEvent(over: Partial<MigrationFailedEvent> = {}): MigrationFailedEvent {
  return {
    event: MIGRATION_EVENT_NAMES.failed,
    traceId: 'trace-1',
    fromVersion: 1,
    toVersion: 3,
    reason: 'copy_failed',
    errorMessage: 'EBUSY: file locked',
    errorCode: 'EBUSY',
    ...over,
  };
}

interface StubWebContents {
  isDestroyed: () => boolean;
  send: ReturnType<typeof vi.fn>;
}
interface StubWin {
  isDestroyed: () => boolean;
  webContents: StubWebContents;
}
function makeStubWin(opts: { destroyed?: boolean; wcDestroyed?: boolean } = {}): StubWin {
  return {
    isDestroyed: () => Boolean(opts.destroyed),
    webContents: {
      isDestroyed: () => Boolean(opts.wcDestroyed),
      send: vi.fn(),
    },
  };
}

// EventEmitter satisfies the subset of IpcMain we use (`on`, `removeListener`).
function makeIpcMain(): EventEmitter & { sentChannels(): string[] } {
  const ee = new EventEmitter() as EventEmitter & { sentChannels(): string[] };
  ee.sentChannels = () => ee.eventNames().map(String);
  return ee;
}

// ---------------------------------------------------------------------------
// Pure decider tests
// ---------------------------------------------------------------------------

describe('reduce — state machine', () => {
  it('hidden + started → in_progress carrying full started payload', () => {
    const ev = startedEvent({ traceId: 't-x', startedAt: 9000 });
    const next = reduce(HIDDEN_STATE, ev);
    expect(next.status).toBe('in_progress');
    if (next.status !== 'in_progress') throw new Error('narrow');
    expect(next.traceId).toBe('t-x');
    expect(next.sourcePath).toBe('C:/legacy/ccsm.db');
    expect(next.fromVersion).toBe(1);
    expect(next.toVersion).toBe(3);
    expect(next.startedAt).toBe(9000);
  });

  it('in_progress + completed → done carrying duration + rows', () => {
    const inProg = reduce(HIDDEN_STATE, startedEvent());
    const next = reduce(inProg, completedEvent({ durationMs: 555, rowsConverted: 7 }));
    expect(next.status).toBe('done');
    if (next.status !== 'done') throw new Error('narrow');
    expect(next.durationMs).toBe(555);
    expect(next.rowsConverted).toBe(7);
  });

  it('in_progress + failed → failed carrying reason + error', () => {
    const inProg = reduce(HIDDEN_STATE, startedEvent());
    const next = reduce(
      inProg,
      failedEvent({ reason: 'disk_full', errorMessage: 'no space', errorCode: 'ENOSPC' })
    );
    expect(next.status).toBe('failed');
    if (next.status !== 'failed') throw new Error('narrow');
    expect(next.reason).toBe('disk_full');
    expect(next.errorMessage).toBe('no space');
    expect(next.errorCode).toBe('ENOSPC');
  });

  it('double-start while in_progress is ignored (first banner wins)', () => {
    const first = reduce(HIDDEN_STATE, startedEvent({ traceId: 'first' }));
    const after = reduce(first, startedEvent({ traceId: 'second' }));
    expect(after).toBe(first);
    if (after.status !== 'in_progress') throw new Error('narrow');
    expect(after.traceId).toBe('first');
  });

  it('completed/failed while hidden are ignored (out-of-order events)', () => {
    expect(reduce(HIDDEN_STATE, completedEvent())).toBe(HIDDEN_STATE);
    expect(reduce(HIDDEN_STATE, failedEvent())).toBe(HIDDEN_STATE);
  });

  it('terminal states (done, failed) ignore further events', () => {
    const inProg = reduce(HIDDEN_STATE, startedEvent());
    const done = reduce(inProg, completedEvent());
    expect(reduce(done, startedEvent({ traceId: 'x' }))).toBe(done);
    expect(reduce(done, failedEvent())).toBe(done);
    expect(reduce(done, completedEvent())).toBe(done);

    const failed = reduce(inProg, failedEvent());
    expect(reduce(failed, startedEvent({ traceId: 'x' }))).toBe(failed);
    expect(reduce(failed, completedEvent())).toBe(failed);
    expect(reduce(failed, failedEvent({ reason: 'corrupt_legacy' }))).toBe(failed);
  });

  it('full happy-path sequence: hidden → in_progress → done', () => {
    let s: ModalState = HIDDEN_STATE;
    s = reduce(s, startedEvent());
    expect(s.status).toBe('in_progress');
    s = reduce(s, completedEvent());
    expect(s.status).toBe('done');
  });

  it('reverse-verify: a completed delivered without a prior started never flips state', () => {
    // If reduce silently accepted any completed, the previous "ignored
    // when hidden" assertion could pass for the wrong reason. Confirm by
    // hammering many completeds against hidden — none should flip.
    let s: ModalState = HIDDEN_STATE;
    for (let i = 0; i < 5; i += 1) s = reduce(s, completedEvent());
    expect(s.status).toBe('hidden');
  });
});

// ---------------------------------------------------------------------------
// Driver wiring tests
// ---------------------------------------------------------------------------

describe('createModalDriver — IPC + timers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('pushes ModalState over IPC_CHANNEL_MODAL_STATE on each transition', () => {
    const win = makeStubWin();
    const ipcMain = makeIpcMain();
    const driver = createModalDriver({
      getMainWindow: () => win as never,
      ipcMain: ipcMain as never,
    });

    driver.applyEvent(startedEvent());
    driver.applyEvent(completedEvent());

    const calls = win.webContents.send.mock.calls;
    expect(calls.length).toBe(2);
    expect(calls[0][0]).toBe(IPC_CHANNEL_MODAL_STATE);
    expect((calls[0][1] as ModalState).status).toBe('in_progress');
    expect((calls[1][1] as ModalState).status).toBe('done');

    driver.dispose();
  });

  it('does NOT push when the decider returns the same state (no-op events)', () => {
    const win = makeStubWin();
    const ipcMain = makeIpcMain();
    const driver = createModalDriver({
      getMainWindow: () => win as never,
      ipcMain: ipcMain as never,
    });

    // Hidden + completed = no transition.
    driver.applyEvent(completedEvent());
    expect(win.webContents.send).not.toHaveBeenCalled();

    driver.applyEvent(startedEvent());
    expect(win.webContents.send).toHaveBeenCalledTimes(1);

    // Double-start: no second send.
    driver.applyEvent(startedEvent({ traceId: 'second' }));
    expect(win.webContents.send).toHaveBeenCalledTimes(1);

    driver.dispose();
  });

  it('done auto-hides after the flash window (default 1000ms)', () => {
    expect(DEFAULT_DONE_FLASH_MS).toBe(1_000);
    const win = makeStubWin();
    const ipcMain = makeIpcMain();
    const driver = createModalDriver({
      getMainWindow: () => win as never,
      ipcMain: ipcMain as never,
    });

    driver.applyEvent(startedEvent());
    driver.applyEvent(completedEvent());
    expect(driver.peek().status).toBe('done');

    vi.advanceTimersByTime(DEFAULT_DONE_FLASH_MS - 1);
    expect(driver.peek().status).toBe('done');
    vi.advanceTimersByTime(1);
    expect(driver.peek().status).toBe('hidden');

    // Verify the hidden push reached the renderer.
    const lastCall = win.webContents.send.mock.calls.at(-1);
    expect(lastCall?.[0]).toBe(IPC_CHANNEL_MODAL_STATE);
    expect((lastCall?.[1] as ModalState).status).toBe('hidden');

    driver.dispose();
  });

  it('honours doneFlashMs override', () => {
    const win = makeStubWin();
    const ipcMain = makeIpcMain();
    const driver = createModalDriver({
      getMainWindow: () => win as never,
      ipcMain: ipcMain as never,
      doneFlashMs: 50,
    });
    driver.applyEvent(startedEvent());
    driver.applyEvent(completedEvent());
    vi.advanceTimersByTime(49);
    expect(driver.peek().status).toBe('done');
    vi.advanceTimersByTime(1);
    expect(driver.peek().status).toBe('hidden');
    driver.dispose();
  });

  it('failed is sticky and does NOT auto-hide', () => {
    const win = makeStubWin();
    const ipcMain = makeIpcMain();
    const driver = createModalDriver({
      getMainWindow: () => win as never,
      ipcMain: ipcMain as never,
    });
    driver.applyEvent(startedEvent());
    driver.applyEvent(failedEvent());

    // Even after a long time, failed remains.
    vi.advanceTimersByTime(60_000);
    expect(driver.peek().status).toBe('failed');

    driver.dispose();
  });

  it('dismiss() clears failed back to hidden + pushes hidden state', () => {
    const win = makeStubWin();
    const ipcMain = makeIpcMain();
    const driver = createModalDriver({
      getMainWindow: () => win as never,
      ipcMain: ipcMain as never,
    });
    driver.applyEvent(startedEvent());
    driver.applyEvent(failedEvent());
    win.webContents.send.mockClear();

    const after = driver.dismiss();
    expect(after.status).toBe('hidden');
    expect(win.webContents.send).toHaveBeenCalledTimes(1);
    expect((win.webContents.send.mock.calls[0][1] as ModalState).status).toBe('hidden');

    driver.dispose();
  });

  it('dismiss() while not failed is a no-op (does not clear in_progress)', () => {
    const win = makeStubWin();
    const ipcMain = makeIpcMain();
    const driver = createModalDriver({
      getMainWindow: () => win as never,
      ipcMain: ipcMain as never,
    });
    driver.applyEvent(startedEvent());
    win.webContents.send.mockClear();

    const after = driver.dismiss();
    expect(after.status).toBe('in_progress');
    expect(win.webContents.send).not.toHaveBeenCalled();

    driver.dispose();
  });

  it('skips send when window is destroyed (no throw, state still tracked)', () => {
    let destroyed = false;
    const win: StubWin = {
      isDestroyed: () => destroyed,
      webContents: {
        isDestroyed: () => destroyed,
        send: vi.fn(),
      },
    };
    const ipcMain = makeIpcMain();
    const driver = createModalDriver({
      getMainWindow: () => win as never,
      ipcMain: ipcMain as never,
    });
    destroyed = true;
    expect(() => driver.applyEvent(startedEvent())).not.toThrow();
    expect(win.webContents.send).not.toHaveBeenCalled();
    expect(driver.peek().status).toBe('in_progress');
    driver.dispose();
  });

  it('skips send when getMainWindow returns null', () => {
    const ipcMain = makeIpcMain();
    const driver = createModalDriver({
      getMainWindow: () => null,
      ipcMain: ipcMain as never,
    });
    expect(() => driver.applyEvent(startedEvent())).not.toThrow();
    expect(driver.peek().status).toBe('in_progress');
    driver.dispose();
  });

  it('IPC relay channel feeds applyEvent (renderer → main path)', () => {
    const win = makeStubWin();
    const ipcMain = makeIpcMain();
    const driver = createModalDriver({
      getMainWindow: () => win as never,
      ipcMain: ipcMain as never,
    });

    ipcMain.emit(IPC_CHANNEL_RELAY_EVENT, {} as never, startedEvent());
    expect(driver.peek().status).toBe('in_progress');
    ipcMain.emit(IPC_CHANNEL_RELAY_EVENT, {} as never, completedEvent());
    expect(driver.peek().status).toBe('done');

    driver.dispose();
  });

  it('IPC dismiss channel triggers dismiss', () => {
    const win = makeStubWin();
    const ipcMain = makeIpcMain();
    const driver = createModalDriver({
      getMainWindow: () => win as never,
      ipcMain: ipcMain as never,
    });
    driver.applyEvent(startedEvent());
    driver.applyEvent(failedEvent());
    expect(driver.peek().status).toBe('failed');

    ipcMain.emit(IPC_CHANNEL_DISMISS, {} as never);
    expect(driver.peek().status).toBe('hidden');

    driver.dispose();
  });

  it('relay drops malformed events without throwing', () => {
    const win = makeStubWin();
    const ipcMain = makeIpcMain();
    const driver = createModalDriver({
      getMainWindow: () => win as never,
      ipcMain: ipcMain as never,
    });

    ipcMain.emit(IPC_CHANNEL_RELAY_EVENT, {} as never, { event: 'bogus' });
    ipcMain.emit(IPC_CHANNEL_RELAY_EVENT, {} as never, null);
    ipcMain.emit(IPC_CHANNEL_RELAY_EVENT, {} as never, { event: MIGRATION_EVENT_NAMES.started });
    expect(driver.peek().status).toBe('hidden');
    expect(win.webContents.send).not.toHaveBeenCalled();

    driver.dispose();
  });

  it('dispose removes IPC listeners and clears the done timer', () => {
    const win = makeStubWin();
    const ipcMain = makeIpcMain();
    const driver = createModalDriver({
      getMainWindow: () => win as never,
      ipcMain: ipcMain as never,
    });
    expect(ipcMain.listenerCount(IPC_CHANNEL_RELAY_EVENT)).toBe(1);
    expect(ipcMain.listenerCount(IPC_CHANNEL_DISMISS)).toBe(1);

    driver.applyEvent(startedEvent());
    driver.applyEvent(completedEvent());
    win.webContents.send.mockClear();

    driver.dispose();
    expect(ipcMain.listenerCount(IPC_CHANNEL_RELAY_EVENT)).toBe(0);
    expect(ipcMain.listenerCount(IPC_CHANNEL_DISMISS)).toBe(0);

    // Timer should be cleared — advancing past flash window must not push.
    vi.advanceTimersByTime(DEFAULT_DONE_FLASH_MS * 2);
    expect(win.webContents.send).not.toHaveBeenCalled();

    // Repeated dispose is a no-op.
    expect(() => driver.dispose()).not.toThrow();
  });

  it('reverse-verify: WITHOUT dispose, listeners stay attached (proves dispose actually does work)', () => {
    const win = makeStubWin();
    const ipcMain = makeIpcMain();
    const driver = createModalDriver({
      getMainWindow: () => win as never,
      ipcMain: ipcMain as never,
    });
    expect(ipcMain.listenerCount(IPC_CHANNEL_RELAY_EVENT)).toBe(1);
    // Don't dispose — count remains 1, and a second driver doubles it.
    const driver2 = createModalDriver({
      getMainWindow: () => win as never,
      ipcMain: ipcMain as never,
    });
    expect(ipcMain.listenerCount(IPC_CHANNEL_RELAY_EVENT)).toBe(2);
    driver.dispose();
    driver2.dispose();
    expect(ipcMain.listenerCount(IPC_CHANNEL_RELAY_EVENT)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Parser tests (defensive structural validation)
// ---------------------------------------------------------------------------

describe('parseEvent — structural validation', () => {
  const { parseEvent } = __testing;

  it('accepts valid started/completed/failed payloads', () => {
    expect(parseEvent(startedEvent())?.event).toBe(MIGRATION_EVENT_NAMES.started);
    expect(parseEvent(completedEvent())?.event).toBe(MIGRATION_EVENT_NAMES.completed);
    expect(parseEvent(failedEvent())?.event).toBe(MIGRATION_EVENT_NAMES.failed);
  });

  it('drops null / non-object / wrong type', () => {
    expect(parseEvent(null)).toBeNull();
    expect(parseEvent(undefined)).toBeNull();
    expect(parseEvent('migration.started')).toBeNull();
    expect(parseEvent(42)).toBeNull();
    expect(parseEvent({})).toBeNull();
  });

  it('drops payloads with unknown event name', () => {
    expect(parseEvent({ event: 'migration.progress', traceId: 't' })).toBeNull();
  });

  it('drops payloads missing required fields', () => {
    expect(parseEvent({ event: MIGRATION_EVENT_NAMES.started })).toBeNull();
    expect(
      parseEvent({
        event: MIGRATION_EVENT_NAMES.completed,
        traceId: 't',
        fromVersion: 1,
        toVersion: 3,
        // missing durationMs + rowsConverted
      })
    ).toBeNull();
    expect(
      parseEvent({
        event: MIGRATION_EVENT_NAMES.failed,
        traceId: 't',
        fromVersion: 1,
        toVersion: 3,
        reason: 'copy_failed',
        // missing errorMessage
      })
    ).toBeNull();
  });

  it('accepts failed without optional errorCode', () => {
    const ev = parseEvent({
      event: MIGRATION_EVENT_NAMES.failed,
      traceId: 't',
      fromVersion: 1,
      toVersion: 3,
      reason: 'copy_failed',
      errorMessage: 'oops',
    });
    expect(ev?.event).toBe(MIGRATION_EVENT_NAMES.failed);
    if (ev?.event !== MIGRATION_EVENT_NAMES.failed) throw new Error('narrow');
    expect(ev.errorCode).toBeUndefined();
  });

  it('rejects failed with non-string errorCode', () => {
    expect(
      parseEvent({
        event: MIGRATION_EVENT_NAMES.failed,
        traceId: 't',
        fromVersion: 1,
        toVersion: 3,
        reason: 'copy_failed',
        errorMessage: 'oops',
        errorCode: 42,
      })
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Wire-contract parity with daemon T30 source-of-truth
// ---------------------------------------------------------------------------

describe('wire-contract parity with daemon/src/db/migration-events.ts (T30)', () => {
  // We can't import from daemon/ in the electron tsconfig context, so
  // grep the file at test time and assert the canonical constant strings
  // match. If T30 ever renames an event, this trip-wires immediately.
  it('event-name string constants match T30', () => {
    const t30Path = path.resolve(__dirname, '../../../daemon/src/db/migration-events.ts');
    const src = fs.readFileSync(t30Path, 'utf8');
    expect(src).toContain(`started: '${MIGRATION_EVENT_NAMES.started}'`);
    expect(src).toContain(`completed: '${MIGRATION_EVENT_NAMES.completed}'`);
    expect(src).toContain(`failed: '${MIGRATION_EVENT_NAMES.failed}'`);
  });
});
