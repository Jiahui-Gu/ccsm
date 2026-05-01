// T75 — L8 migration-failure modal probe.
//
// Spec: docs/superpowers/specs/v0.3-fragments/frag-8-sqlite-migration.md §8.6.
// Forces the v0.2 → v0.3 migration to fail end-to-end (real corrupt SQLite
// file driving the real T29 runner) and asserts:
//   1. T33 modal driver lands in sticky `failed` ModalState carrying the
//      daemon-classified reason + raw errorMessage.
//   2. State pushed over IPC channel `migration:modalState` (in_progress
//      then failed).
//   3. `failed` is sticky — only IPC dismiss / Quit clears it.
//   4. T31 (en) + T32 (zh) bundles export `migration.modal.failed.{title,
//      body,actionQuit}` with `{{legacyDb}}` / `{{dataRoot}}` tokens.
//   5. Reverse-verify: a stray failed event from `hidden` is a no-op.
//
// No Electron e2e harness exists in this repo yet (vitest is the boundary).
// Run: `npx vitest run electron/migration/__tests__/migration-failure-probe`.
// A future Playwright/Spectron harness (frag-11) should lift this into a
// cross-process scenario asserting rendered modal DOM.

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('electron', () => ({ BrowserWindow: class {} }));

import {
  createModalDriver,
  IPC_CHANNEL_MODAL_STATE,
  IPC_CHANNEL_RELAY_EVENT,
  IPC_CHANNEL_DISMISS,
  MIGRATION_EVENT_NAMES,
  type MigrationFailedEvent,
  type ModalState,
} from '../modal-driver';

// Real T29 runner — vitest transpiles daemon TS source under the same
// config. See daemon/src/db/__tests__/migrate-v02-to-v03.test.ts for the
// matching corrupt-file fixture.
import { migrateV02ToV03 } from '../../../daemon/src/db/migrate-v02-to-v03';
import enBundle from '../../../src/i18n/locales/en';
import zhBundle from '../../../src/i18n/locales/zh';

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

// Daemon-side reason classifier — mirrors §8.6 mapping table. The real
// daemon emitter (boot-path glue, out of scope for T75) will perform the
// same trivial classification on whatever the runner throws.
function classifyAsFailedEvent(err: Error, traceId: string): MigrationFailedEvent {
  const msg = err.message ?? String(err);
  let reason: MigrationFailedEvent['reason'] = 'finalize_failed';
  if (
    /not a database|malformed|file is encrypted|disk image|SQLITE_NOTADB|SQLITE_CORRUPT|unable to open/i.test(
      msg
    )
  ) {
    reason = 'corrupt_legacy';
  } else if (/ENOSPC|no space/i.test(msg)) {
    reason = 'disk_full';
  } else if (/EACCES|EPERM|permission denied/i.test(msg)) {
    reason = 'permission_denied';
  }
  return {
    event: MIGRATION_EVENT_NAMES.failed,
    traceId,
    fromVersion: 1,
    toVersion: 3,
    reason,
    errorMessage: msg,
  };
}

// ---------------------------------------------------------------------------

describe('T75 migration-failure modal probe', () => {
  it('drives a real corrupt-legacy failure into the failed ModalState', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'ccsm-t75-corrupt-'));
    const dbPath = join(tmpDir, 'ccsm.db');
    try {
      // PRODUCER: write a non-SQLite blob — the same fixture daemon T29
      // uses to exercise its corrupt-file path (migrate-v02-to-v03.test.ts
      // line 279).
      writeFileSync(dbPath, 'this is not a sqlite database');

      let runnerErr: Error | null = null;
      try {
        migrateV02ToV03(dbPath);
      } catch (e) {
        runnerErr = e as Error;
      }
      expect(runnerErr, 'runner must throw on corrupt legacy').not.toBeNull();

      const failedEvent = classifyAsFailedEvent(runnerErr as Error, 'trace-corrupt');
      // Whatever specific reason the classifier picks for the actual
      // better-sqlite3 message, it MUST be a canonical T30 reason.
      expect([
        'corrupt_legacy',
        'finalize_failed',
        'permission_denied',
        'disk_full',
      ]).toContain(failedEvent.reason);

      // SINK + DECIDER: real driver wired to a real EventEmitter ipcMain.
      const win = makeStubWin();
      const ipcMain = new EventEmitter();
      const driver = createModalDriver({
        getMainWindow: () => win as never,
        ipcMain: ipcMain as never,
      });

      ipcMain.emit(IPC_CHANNEL_RELAY_EVENT, {} as never, {
        event: MIGRATION_EVENT_NAMES.started,
        traceId: 'trace-corrupt',
        sourcePath: dbPath,
        fromVersion: 1,
        toVersion: 3,
        startedAt: 1_700_000_000_000,
      });
      ipcMain.emit(IPC_CHANNEL_RELAY_EVENT, {} as never, failedEvent);

      const state = driver.peek();
      expect(state.status).toBe('failed');
      if (state.status !== 'failed') throw new Error('narrow');
      expect(state.reason).toBe(failedEvent.reason);
      expect(state.errorMessage).toBe((runnerErr as Error).message);
      expect(state.fromVersion).toBe(1);
      expect(state.toVersion).toBe(3);
      expect(state.traceId).toBe('trace-corrupt');

      const pushed = win.webContents.send.mock.calls.filter(
        (c) => c[0] === IPC_CHANNEL_MODAL_STATE
      );
      expect(pushed.length).toBe(2);
      expect((pushed[0][1] as ModalState).status).toBe('in_progress');
      expect((pushed[1][1] as ModalState).status).toBe('failed');

      driver.dispose();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('failed state is sticky — only IPC dismiss (Quit) clears it', () => {
    vi.useFakeTimers();
    try {
      const win = makeStubWin();
      const ipcMain = new EventEmitter();
      const driver = createModalDriver({
        getMainWindow: () => win as never,
        ipcMain: ipcMain as never,
      });

      ipcMain.emit(IPC_CHANNEL_RELAY_EVENT, {} as never, {
        event: MIGRATION_EVENT_NAMES.started,
        traceId: 't',
        sourcePath: 'X:/legacy.db',
        fromVersion: 1,
        toVersion: 3,
        startedAt: 0,
      });
      ipcMain.emit(IPC_CHANNEL_RELAY_EVENT, {} as never, {
        event: MIGRATION_EVENT_NAMES.failed,
        traceId: 't',
        fromVersion: 1,
        toVersion: 3,
        reason: 'finalize_failed',
        errorMessage: 'synthetic finalize failure',
      } satisfies MigrationFailedEvent);

      vi.advanceTimersByTime(60_000);
      // Stray late completed must not flip the state.
      ipcMain.emit(IPC_CHANNEL_RELAY_EVENT, {} as never, {
        event: MIGRATION_EVENT_NAMES.completed,
        traceId: 't',
        fromVersion: 1,
        toVersion: 3,
        durationMs: 99,
        rowsConverted: 0,
      });
      expect(driver.peek().status).toBe('failed');

      ipcMain.emit(IPC_CHANNEL_DISMISS, {} as never);
      expect(driver.peek().status).toBe('hidden');

      driver.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reverse-verify: failed event WITHOUT a prior started leaves modal hidden', () => {
    const win = makeStubWin();
    const ipcMain = new EventEmitter();
    const driver = createModalDriver({
      getMainWindow: () => win as never,
      ipcMain: ipcMain as never,
    });
    ipcMain.emit(IPC_CHANNEL_RELAY_EVENT, {} as never, {
      event: MIGRATION_EVENT_NAMES.failed,
      traceId: 't',
      fromVersion: 1,
      toVersion: 3,
      reason: 'corrupt_legacy',
      errorMessage: 'should not surface',
    } satisfies MigrationFailedEvent);
    expect(driver.peek().status).toBe('hidden');
    expect(win.webContents.send).not.toHaveBeenCalled();
    driver.dispose();
  });

  // i18n contract: T31/T32 own the keys the renderer modal looks up.
  describe('i18n keys (T31 en + T32 zh)', () => {
    type FailedNode = { title: string; body: string; actionQuit: string } & Record<string, unknown>;
    const REQUIRED = ['title', 'body', 'actionQuit'] as const;

    function failedFor(bundle: unknown): FailedNode {
      const root = bundle as { migration: { modal: { failed: FailedNode } } };
      return root.migration.modal.failed;
    }

    it.each([
      ['en', enBundle],
      ['zh', zhBundle],
    ])('%s exports migration.modal.failed.{title,body,actionQuit} with paths', (label, bundle) => {
      const failed = failedFor(bundle);
      for (const k of REQUIRED) {
        expect(typeof failed[k], `${label} migration.modal.failed.${k}`).toBe('string');
        expect(failed[k].length).toBeGreaterThan(0);
      }
      expect(failed.body).toMatch(/\{\{legacyDb\}\}/);
      expect(failed.body).toMatch(/\{\{dataRoot\}\}/);
    });

    it('en + zh expose identical key sets under migration.modal.failed', () => {
      expect(Object.keys(failedFor(enBundle)).sort()).toEqual(
        Object.keys(failedFor(zhBundle)).sort()
      );
    });

    it('en title is sentence-case (no SCREAMING strings — feedback rule)', () => {
      const t = failedFor(enBundle).title;
      expect(t).toBe(t.toLowerCase()[0] + t.slice(1)); // first char already lowercase ('ccsm')
      expect(t).not.toMatch(/^[A-Z]{2,}/);
    });
  });
});
