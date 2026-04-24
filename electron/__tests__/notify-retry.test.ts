import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  scheduleQuestionRetry,
  cancelQuestionRetry,
  __setRetrySchedulerForTests,
  __pendingRetryCountForTests,
  __resetRetryStateForTests,
} from '../notify-retry';
import * as notifyMod from '../notify';

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
});
