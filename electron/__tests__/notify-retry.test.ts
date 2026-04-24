import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  scheduleQuestionRetry,
  cancelQuestionRetry,
  __setRetrySchedulerForTests,
  __pendingRetryCountForTests,
  __resetRetryStateForTests,
} from '../notify-retry';
import * as notifyMod from '../notify';
import {
  setNotifyRuntimeState,
  __resetNotifyRuntimeStateForTests,
} from '../notify-bootstrap';

vi.mock('electron', () => {
  const fakeWindows: Array<{
    isDestroyed: () => boolean;
    isFocused: () => boolean;
    isVisible: () => boolean;
  }> = [];
  return {
    BrowserWindow: {
      getAllWindows: () => fakeWindows,
      __setFakeWindows: (
        wins: Array<{ focused: boolean; visible: boolean; destroyed?: boolean }>,
      ) => {
        fakeWindows.length = 0;
        for (const w of wins) {
          fakeWindows.push({
            isDestroyed: () => !!w.destroyed,
            isFocused: () => w.focused,
            isVisible: () => w.visible,
          });
        }
      },
    },
  };
});

// We run the retry logic against a virtual scheduler so the 30s timer is
// observable instantly. Real setTimeout would either slow tests by 30s or
// require vitest's fake-timers — using a hand-rolled fake keeps the surface
// explicit and matches how the e2e probe drives the same seam.
type Pending = { cb: () => void; delayMs: number; cancelled: boolean };

describe('notify-retry', () => {
  let queue: Pending[];
  let fakeTimerSeq: number;
  let timerById: Map<number, Pending>;

  beforeEach(() => {
    queue = [];
    fakeTimerSeq = 1;
    timerById = new Map();
    __resetRetryStateForTests();
    __setRetrySchedulerForTests(
      (cb, delayMs) => {
        const entry: Pending = { cb, delayMs, cancelled: false };
        queue.push(entry);
        const id = fakeTimerSeq++;
        timerById.set(id, entry);
        // setTimeout returns a Timeout in node; we lie and return a number,
        // which is fine because the canceller resolves it back via
        // timerById lookup.
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      (handle) => {
        const entry = timerById.get(handle as unknown as number);
        if (entry) entry.cancelled = true;
      },
    );
  });

  afterEach(() => {
    __setRetrySchedulerForTests(null, null);
    __resetRetryStateForTests();
    __resetNotifyRuntimeStateForTests();
    vi.restoreAllMocks();
  });

  function fireDueTimers() {
    // Drain non-cancelled entries that have been scheduled. Order = FIFO,
    // matching real setTimeout when delays are equal.
    const due = queue.filter((q) => !q.cancelled);
    queue = queue.filter((q) => q.cancelled);
    for (const e of due) e.cb();
  }

  const basePayload = {
    toastId: 'q-req-1',
    sessionName: 'Test',
    question: 'Pick one',
    selectionKind: 'single' as const,
    optionCount: 2,
    cwdBasename: 'cwd',
  };

  it('schedules a retry on first call and the entry is tracked', () => {
    expect(__pendingRetryCountForTests()).toBe(0);
    scheduleQuestionRetry(basePayload);
    expect(__pendingRetryCountForTests()).toBe(1);
    expect(queue.length).toBe(1);
    expect(queue[0].delayMs).toBe(30_000);
  });

  it('is idempotent — second schedule for the same toastId does not stack', () => {
    scheduleQuestionRetry(basePayload);
    scheduleQuestionRetry(basePayload);
    expect(__pendingRetryCountForTests()).toBe(1);
    expect(queue.length).toBe(1);
  });

  it('fires notifyQuestion once when the timer elapses, then drops the entry', () => {
    const spy = vi
      .spyOn(notifyMod, 'notifyQuestion')
      .mockResolvedValue(undefined);
    scheduleQuestionRetry(basePayload);
    fireDueTimers();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(basePayload);
    expect(__pendingRetryCountForTests()).toBe(0);
  });

  it('caps at exactly 1 retry — re-firing after the retry fires does not schedule again', () => {
    const spy = vi
      .spyOn(notifyMod, 'notifyQuestion')
      .mockResolvedValue(undefined);
    scheduleQuestionRetry(basePayload);
    fireDueTimers();
    // Drain finished — pending map is empty. A user could in theory call
    // scheduleQuestionRetry again with the same id (e.g. a brand-new
    // question reuses an id) and that would schedule a fresh retry. But
    // the lifecycle path never re-emits without going through cancel
    // first; we assert here that ABSENT a second schedule, no retry fires.
    fireDueTimers();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('cancelQuestionRetry clears the timer and removes the entry', () => {
    const spy = vi
      .spyOn(notifyMod, 'notifyQuestion')
      .mockResolvedValue(undefined);
    scheduleQuestionRetry(basePayload);
    expect(__pendingRetryCountForTests()).toBe(1);
    cancelQuestionRetry(basePayload.toastId);
    expect(__pendingRetryCountForTests()).toBe(0);
    fireDueTimers();
    expect(spy).not.toHaveBeenCalled();
  });

  it('cancelQuestionRetry is a safe no-op when no entry exists', () => {
    expect(() => cancelQuestionRetry('does-not-exist')).not.toThrow();
    expect(__pendingRetryCountForTests()).toBe(0);
  });

  it('schedule with an empty toastId is rejected (no entry created)', () => {
    scheduleQuestionRetry({ ...basePayload, toastId: '' });
    expect(__pendingRetryCountForTests()).toBe(0);
    expect(queue.length).toBe(0);
  });

  it('multiple distinct toastIds each get their own retry timer', () => {
    const spy = vi
      .spyOn(notifyMod, 'notifyQuestion')
      .mockResolvedValue(undefined);
    scheduleQuestionRetry({ ...basePayload, toastId: 'q-a' });
    scheduleQuestionRetry({ ...basePayload, toastId: 'q-b' });
    expect(__pendingRetryCountForTests()).toBe(2);
    cancelQuestionRetry('q-a');
    fireDueTimers();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].toastId).toBe('q-b');
  });

  // Fire-time gate rechecks (#307). The retry timer fires in main ~30s
  // after schedule; by then the user could have toggled notifications off
  // or focused the question's session. Schedule-time gates are NOT
  // sufficient — fire-time MUST recheck.
  describe('fire-time gate rechecks (#307)', () => {
    it('suppresses fire when notifications were disabled during the window', () => {
      const spy = vi
        .spyOn(notifyMod, 'notifyQuestion')
        .mockResolvedValue(undefined);
      // Schedule with state that would normally allow the retry.
      setNotifyRuntimeState({ notificationsEnabled: true, activeSessionId: null });
      scheduleQuestionRetry(basePayload, 'session-a');
      // Simulate the user toggling notifications off during the 30s window.
      setNotifyRuntimeState({ notificationsEnabled: false });
      fireDueTimers();
      expect(spy).not.toHaveBeenCalled();
    });

    it('fires when notifications stay enabled and the user is on a different session', () => {
      const spy = vi
        .spyOn(notifyMod, 'notifyQuestion')
        .mockResolvedValue(undefined);
      setNotifyRuntimeState({
        notificationsEnabled: true,
        activeSessionId: 'session-other',
      });
      scheduleQuestionRetry(basePayload, 'session-a');
      fireDueTimers();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(basePayload);
    });

    it('fires when sessionId is unknown (null) regardless of focus state', () => {
      // No sessionId carried (legacy callers / defensive default) — only
      // the global notifications-enabled gate applies. Without sessionId,
      // we can't compare against activeSessionId so the focus check is
      // skipped and the retry proceeds.
      const spy = vi
        .spyOn(notifyMod, 'notifyQuestion')
        .mockResolvedValue(undefined);
      setNotifyRuntimeState({
        notificationsEnabled: true,
        activeSessionId: 'session-a',
      });
      scheduleQuestionRetry(basePayload, null);
      fireDueTimers();
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('suppresses fire when window is focused AND activeSessionId matches', async () => {
      const spy = vi
        .spyOn(notifyMod, 'notifyQuestion')
        .mockResolvedValue(undefined);
      // Reach in to flip the fake BrowserWindow into a focused state.
      const electron = await import('electron');
      (electron.BrowserWindow as unknown as {
        __setFakeWindows: (
          wins: Array<{ focused: boolean; visible: boolean }>,
        ) => void;
      }).__setFakeWindows([{ focused: true, visible: true }]);
      setNotifyRuntimeState({
        notificationsEnabled: true,
        activeSessionId: 'session-a',
      });
      scheduleQuestionRetry(basePayload, 'session-a');
      fireDueTimers();
      expect(spy).not.toHaveBeenCalled();
      // Reset the fake windows so other tests aren't affected.
      (electron.BrowserWindow as unknown as {
        __setFakeWindows: (
          wins: Array<{ focused: boolean; visible: boolean }>,
        ) => void;
      }).__setFakeWindows([]);
    });
  });

  // Toast-action reject must cancel any pending question retry (#308).
  // The toast-action router in main.ts calls `cancelQuestionRetry` on both
  // `q-${requestId}` and the bare `requestId` so a defensive future change
  // routing question activations through the same path doesn't leak the
  // timer past the user's explicit reject.
  describe('toast-action reject cancellation (#308)', () => {
    it('cancelQuestionRetry on matching q-prefixed id removes a scheduled retry before it fires', () => {
      const spy = vi
        .spyOn(notifyMod, 'notifyQuestion')
        .mockResolvedValue(undefined);
      // Simulate a question scheduled with the lifecycle's q-${requestId}
      // toast id.
      const requestId = 'req-reject-1';
      const toastId = `q-${requestId}`;
      scheduleQuestionRetry({ ...basePayload, toastId }, 'session-a');
      expect(__pendingRetryCountForTests()).toBe(1);

      // Mirror the main.ts toast-action reject branch — cancel against both
      // keys (`q-${requestId}` and the bare requestId). The bare-id call is
      // a safe no-op when no entry exists; the q-prefixed call hits the
      // pending entry and removes it.
      cancelQuestionRetry(`q-${requestId}`);
      cancelQuestionRetry(requestId);

      expect(__pendingRetryCountForTests()).toBe(0);
      fireDueTimers();
      expect(spy).not.toHaveBeenCalled();
    });
  });
});
