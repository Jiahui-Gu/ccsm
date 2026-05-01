// T33 — Migration in-progress modal driver (frag-8 §8.5 / §8.6).
//
// SRP layering (per project rules `feedback_single_responsibility`):
//   * PRODUCER: the daemon migration runner (T29) emits MigrationEvent
//     records over IPC. We do not own production here.
//   * DECIDER: `reduce(state, event)` — pure state-transition function
//     turning the {hidden, in_progress, failed, done} state machine.
//     Hermetically testable, no I/O.
//   * SINK: `createModalDriver` wires the IPC stream to the decider and
//     pushes the resolved ModalState to the renderer over channel
//     `migration:modalState`. Side effect is exactly one `webContents.send`
//     per state transition.
//
// State machine (frag-8 §8.6 manager r9 lock — indeterminate spinner,
// progress event NOT in the wire contract; T30 declares only the three
// events `migration.started` / `migration.completed` / `migration.failed`):
//
//   hidden ──started──▶ in_progress ──completed──▶ done ──(1s)──▶ hidden
//                                  └──failed─────▶ failed (sticky until
//                                                          dismiss())
//   any other event from `hidden`              → ignored
//   `started` while in_progress / done / failed → ignored (double-start
//                                                 is a no-op, the first
//                                                 banner stays sticky;
//                                                 frag-8 §8.5 S1 ensures
//                                                 only one runner ever
//                                                 fires per boot, but the
//                                                 driver is defensive).
//
// `done` is a brief flash (DEFAULT_DONE_FLASH_MS = 1000ms) that auto-
// transitions to `hidden`. `failed` is sticky — only `dismiss()` (renderer
// modal X / Quit-button click handler) can clear it back to `hidden`.
// Per spec the failed modal's only action is "Quit ccsm" so in production
// the dismiss path is mostly academic, but exposing it keeps the driver
// usable from tests and from any future renderer that wants to clear the
// state on quit.
//
// IPC channel naming follows the existing convention in
// `electron/notify/sinks/flashSink.ts`: `<domain>:<event>` lower-camel.

import type { BrowserWindow, IpcMain, IpcMainEvent } from 'electron';

// ---------------------------------------------------------------------------
// Wire-contract types — structural mirror of `daemon/src/db/migration-events.ts`.
//
// We cannot `import` from `daemon/` because `tsconfig.electron.json` has
// `include: ["electron/**/*", "src/shared/**/*"]` and excludes the daemon
// source tree. Re-declaring the union keeps the electron build self-
// contained; the contract is closed (only three events ever) and the
// daemon-side file is the source of truth. If T30 ever grows a fourth
// event, both files must be updated together — the test
// `modal-driver.test.ts > 'wire-contract event names match T30 constants'`
// will fail loud if these strings drift.
// ---------------------------------------------------------------------------

export const MIGRATION_EVENT_NAMES = {
  started: 'migration.started',
  completed: 'migration.completed',
  failed: 'migration.failed',
} as const;

export type MigrationEventName =
  (typeof MIGRATION_EVENT_NAMES)[keyof typeof MIGRATION_EVENT_NAMES];

export interface MigrationStartedEvent {
  readonly event: typeof MIGRATION_EVENT_NAMES.started;
  readonly traceId: string;
  readonly sourcePath: string;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly startedAt: number;
}

export interface MigrationCompletedEvent {
  readonly event: typeof MIGRATION_EVENT_NAMES.completed;
  readonly traceId: string;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly durationMs: number;
  readonly rowsConverted: number;
}

export interface MigrationFailedEvent {
  readonly event: typeof MIGRATION_EVENT_NAMES.failed;
  readonly traceId: string;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly reason: string;
  readonly errorMessage: string;
  readonly errorCode?: string;
}

export type MigrationEvent =
  | MigrationStartedEvent
  | MigrationCompletedEvent
  | MigrationFailedEvent;

// ---------------------------------------------------------------------------
// Modal state — what the renderer sees.
// ---------------------------------------------------------------------------

export type ModalStatus = 'hidden' | 'in_progress' | 'failed' | 'done';

/**
 * Discriminated union sent to the renderer. Renderer translates via the
 * `migration.modal.in_progress.*` / `migration.modal.failed.*` i18n keys.
 *
 * - `hidden`        — modal not shown.
 * - `in_progress`   — indeterminate spinner; carries `traceId` for support
 *                     correlation with daemon log.
 * - `done`          — brief success flash before auto-hiding.
 * - `failed`        — sticky fatal-error modal; carries the reason +
 *                     errorMessage so the renderer can surface support
 *                     details (frag-8 §8.6 modal copy).
 */
export type ModalState =
  | { status: 'hidden' }
  | {
      status: 'in_progress';
      traceId: string;
      sourcePath: string;
      fromVersion: number;
      toVersion: number;
      startedAt: number;
    }
  | {
      status: 'done';
      traceId: string;
      fromVersion: number;
      toVersion: number;
      durationMs: number;
      rowsConverted: number;
    }
  | {
      status: 'failed';
      traceId: string;
      fromVersion: number;
      toVersion: number;
      reason: string;
      errorMessage: string;
      errorCode?: string;
    };

export const HIDDEN_STATE: ModalState = { status: 'hidden' };

/** Default flash duration before `done` → `hidden`. 1s per task spec. */
export const DEFAULT_DONE_FLASH_MS = 1_000;

/** IPC channel for state push: main → renderer. */
export const IPC_CHANNEL_MODAL_STATE = 'migration:modalState';

/** IPC channel renderer → main: forwards a daemon migration event. The
 *  daemon talks to the renderer over the existing daemon socket; the
 *  renderer relays each event through this channel so the driver (which
 *  runs in main, where the BrowserWindow lives) can compute state and
 *  push the result back. Keeping the relay in the renderer side avoids
 *  giving main a second daemon connection just to listen for migration
 *  events.
 *
 *  Alternative (when wired): if a future task gives main a direct
 *  daemon-event subscription, the driver can call `applyEvent` from there
 *  and this channel becomes unused. Exposed as a constant so the renderer
 *  bridge has a single source of truth. */
export const IPC_CHANNEL_RELAY_EVENT = 'migration:relayEvent';

/** IPC channel renderer → main: user dismissed the failed modal. */
export const IPC_CHANNEL_DISMISS = 'migration:dismiss';

// ---------------------------------------------------------------------------
// Pure decider — `reduce(state, event)`.
// ---------------------------------------------------------------------------

/**
 * Compute the next modal state from the current state + an incoming event.
 *
 * Rules (see file header diagram):
 *   - `hidden + started`            → `in_progress`
 *   - `in_progress + completed`     → `done`         (caller schedules
 *                                                     the auto-hide)
 *   - `in_progress + failed`        → `failed`
 *   - `started` while non-`hidden`  → unchanged (defensive double-start)
 *   - any non-`started` event while `hidden` → unchanged (out-of-order /
 *                                                          stray event)
 *   - `completed` / `failed` while `done` or `failed` → unchanged
 *     (terminal; only `dismiss` resets to hidden)
 */
export function reduce(state: ModalState, event: MigrationEvent): ModalState {
  switch (event.event) {
    case MIGRATION_EVENT_NAMES.started: {
      if (state.status !== 'hidden') {
        // Double-start: the first transition wins. Logging is the caller's
        // job; the decider stays pure.
        return state;
      }
      return {
        status: 'in_progress',
        traceId: event.traceId,
        sourcePath: event.sourcePath,
        fromVersion: event.fromVersion,
        toVersion: event.toVersion,
        startedAt: event.startedAt,
      };
    }
    case MIGRATION_EVENT_NAMES.completed: {
      if (state.status !== 'in_progress') return state;
      return {
        status: 'done',
        traceId: event.traceId,
        fromVersion: event.fromVersion,
        toVersion: event.toVersion,
        durationMs: event.durationMs,
        rowsConverted: event.rowsConverted,
      };
    }
    case MIGRATION_EVENT_NAMES.failed: {
      if (state.status !== 'in_progress') return state;
      return {
        status: 'failed',
        traceId: event.traceId,
        fromVersion: event.fromVersion,
        toVersion: event.toVersion,
        reason: event.reason,
        errorMessage: event.errorMessage,
        errorCode: event.errorCode,
      };
    }
    default: {
      // Exhaustiveness guard — if T30 ever adds a fourth event, this
      // forces a compile error (`never` narrowing).
      const _exhaustive: never = event;
      void _exhaustive;
      return state;
    }
  }
}

// ---------------------------------------------------------------------------
// Sink wiring — connects IPC + timers + state to the renderer.
// ---------------------------------------------------------------------------

export interface ModalDriverOptions {
  /** Returns the BrowserWindow we should push state to, or null if the
   *  window isn't ready yet. Mirrors flashSink's pattern. */
  getMainWindow: () => BrowserWindow | null;
  /** ipcMain handle (passed in for testability). */
  ipcMain: IpcMain;
  /** Override the `done` auto-hide duration in tests. */
  doneFlashMs?: number;
}

export interface ModalDriver {
  /**
   * Apply a migration event. Computes next state, sends to renderer if
   * the state changed, schedules auto-hide on `done`.
   *
   * Returns the resolved next state (useful for tests + callers that want
   * to log).
   */
  applyEvent(event: MigrationEvent): ModalState;
  /** User dismissed the failed modal — reset to `hidden`. */
  dismiss(): ModalState;
  /** Inspect current state (test seam). */
  peek(): ModalState;
  /** Tear down listeners + timers. Idempotent. */
  dispose(): void;
}

export function createModalDriver(opts: ModalDriverOptions): ModalDriver {
  const doneFlashMs = opts.doneFlashMs ?? DEFAULT_DONE_FLASH_MS;
  let state: ModalState = HIDDEN_STATE;
  let doneTimer: NodeJS.Timeout | null = null;
  let disposed = false;

  function send(next: ModalState): void {
    const win = opts.getMainWindow();
    if (!win || win.isDestroyed()) return;
    if (win.webContents.isDestroyed()) return;
    try {
      win.webContents.send(IPC_CHANNEL_MODAL_STATE, next);
    } catch (err) {
      console.warn('[migration/modal-driver] send failed', err);
    }
  }

  function clearDoneTimer(): void {
    if (doneTimer) {
      clearTimeout(doneTimer);
      doneTimer = null;
    }
  }

  function scheduleDoneAutoHide(): void {
    clearDoneTimer();
    const t = setTimeout(() => {
      doneTimer = null;
      // Only flip to hidden if we're still in `done`; if a new migration
      // somehow started in the meantime (shouldn't happen but defensive)
      // don't clobber its state.
      if (state.status === 'done') {
        state = HIDDEN_STATE;
        send(state);
      }
    }, doneFlashMs);
    if (typeof t.unref === 'function') t.unref();
    doneTimer = t;
  }

  function transitionTo(next: ModalState): ModalState {
    if (next === state) return state;
    state = next;
    send(state);
    if (state.status === 'done') scheduleDoneAutoHide();
    return state;
  }

  // IPC bridge from renderer relay channel.
  function onRelay(_e: IpcMainEvent, raw: unknown): void {
    if (disposed) return;
    const ev = parseEvent(raw);
    if (!ev) return;
    applyEvent(ev);
  }
  function onDismiss(_e: IpcMainEvent): void {
    if (disposed) return;
    dismiss();
  }

  opts.ipcMain.on(IPC_CHANNEL_RELAY_EVENT, onRelay);
  opts.ipcMain.on(IPC_CHANNEL_DISMISS, onDismiss);

  function applyEvent(event: MigrationEvent): ModalState {
    const next = reduce(state, event);
    return transitionTo(next);
  }

  function dismiss(): ModalState {
    // Only meaningful from `failed`; ignore otherwise (e.g. a stray
    // dismiss while `in_progress` would be a UI bug — the modal is
    // dismissable: false in that state per frag-8 §6.8).
    if (state.status !== 'failed') return state;
    return transitionTo(HIDDEN_STATE);
  }

  return {
    applyEvent,
    dismiss,
    peek() {
      return state;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearDoneTimer();
      opts.ipcMain.removeListener(IPC_CHANNEL_RELAY_EVENT, onRelay);
      opts.ipcMain.removeListener(IPC_CHANNEL_DISMISS, onDismiss);
    },
  };
}

// ---------------------------------------------------------------------------
// Defensive event parser for the IPC relay path.
//
// IPC payloads cross a trust boundary (renderer can technically push any
// shape). We do a structural check matching the T30 contract; anything
// that doesn't match is dropped silently (caller logs at the IPC layer
// if it cares).
// ---------------------------------------------------------------------------

function parseEvent(raw: unknown): MigrationEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const name = obj.event;
  if (typeof name !== 'string') return null;
  switch (name) {
    case MIGRATION_EVENT_NAMES.started: {
      if (
        typeof obj.traceId === 'string' &&
        typeof obj.sourcePath === 'string' &&
        typeof obj.fromVersion === 'number' &&
        typeof obj.toVersion === 'number' &&
        typeof obj.startedAt === 'number'
      ) {
        return {
          event: MIGRATION_EVENT_NAMES.started,
          traceId: obj.traceId,
          sourcePath: obj.sourcePath,
          fromVersion: obj.fromVersion,
          toVersion: obj.toVersion,
          startedAt: obj.startedAt,
        };
      }
      return null;
    }
    case MIGRATION_EVENT_NAMES.completed: {
      if (
        typeof obj.traceId === 'string' &&
        typeof obj.fromVersion === 'number' &&
        typeof obj.toVersion === 'number' &&
        typeof obj.durationMs === 'number' &&
        typeof obj.rowsConverted === 'number'
      ) {
        return {
          event: MIGRATION_EVENT_NAMES.completed,
          traceId: obj.traceId,
          fromVersion: obj.fromVersion,
          toVersion: obj.toVersion,
          durationMs: obj.durationMs,
          rowsConverted: obj.rowsConverted,
        };
      }
      return null;
    }
    case MIGRATION_EVENT_NAMES.failed: {
      if (
        typeof obj.traceId === 'string' &&
        typeof obj.fromVersion === 'number' &&
        typeof obj.toVersion === 'number' &&
        typeof obj.reason === 'string' &&
        typeof obj.errorMessage === 'string' &&
        (obj.errorCode === undefined || typeof obj.errorCode === 'string')
      ) {
        return {
          event: MIGRATION_EVENT_NAMES.failed,
          traceId: obj.traceId,
          fromVersion: obj.fromVersion,
          toVersion: obj.toVersion,
          reason: obj.reason,
          errorMessage: obj.errorMessage,
          errorCode: obj.errorCode as string | undefined,
        };
      }
      return null;
    }
    default:
      return null;
  }
}

// Test-only export for parser coverage.
export const __testing = { parseEvent };
