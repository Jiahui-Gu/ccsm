import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  showNotification,
  type ShowNotificationPayload,
} from '../notifications';
import {
  configureNotify,
  __setNotifyImporter,
  probeNotifyAvailability,
} from '../notify';
import { __resetBootstrapForTests } from '../notify-bootstrap';
import {
  __resetRetryStateForTests,
  __setRetrySchedulerForTests,
  __pendingRetryCountForTests,
} from '../notify-retry';

// Mock electron's BrowserWindow + Notification surface — the test harness
// is plain node so we can't pull in real Electron. We capture every
// Notification constructor call so the showNotification pipeline can be
// asserted end-to-end (legacy body composition + adaptive payload).
let lastNotificationCtor: { title: string; body: string; silent: boolean } | undefined;
const showSpy = vi.fn();
const onClickSpy = vi.fn();

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  Notification: class FakeNotification {
    title: string;
    body: string;
    silent: boolean;
    constructor(opts: { title: string; body: string; silent: boolean }) {
      this.title = opts.title;
      this.body = opts.body;
      this.silent = opts.silent;
      lastNotificationCtor = opts;
    }
    static isSupported() {
      return true;
    }
    on(event: string, cb: () => void) {
      if (event === 'click') onClickSpy.mockImplementation(cb);
    }
    show() {
      showSpy();
    }
  },
}));

describe('showNotification — done rich content (#252)', () => {
  let donePayloads: Array<Record<string, unknown>>;

  beforeEach(async () => {
    lastNotificationCtor = undefined;
    showSpy.mockClear();
    onClickSpy.mockReset();
    donePayloads = [];
    __resetBootstrapForTests();
    __resetRetryStateForTests();
    __setRetrySchedulerForTests(
      // Swallow timers so the retry can't actually fire during these tests.
      // notifyDone tests below don't exercise question retries; question
      // tests use the same swallow-and-record fake from notify-retry.test.ts.
      () => 0 as unknown as ReturnType<typeof setTimeout>,
      () => {},
    );
    __setNotifyImporter(async () => ({
      Notifier: {
        create: async () => ({
          permission: () => {},
          question: () => {},
          done: (p: Record<string, unknown>) => donePayloads.push(p),
          dismiss: () => {},
        }),
      },
    }));
    configureNotify({
      appId: 'test',
      appName: 'Test',
      onAction: () => {},
    });
    // Force the dynamic import to resolve so `isNotifyAvailable()` flips
    // true before we call showNotification.
    await probeNotifyAvailability();
  });

  afterEach(() => {
    __setNotifyImporter(null);
    __setRetrySchedulerForTests(null, null);
    __resetRetryStateForTests();
  });

  it('legacy toast body falls back to truncated lastAssistantMsg when host gives no body', () => {
    const longMsg = 'a'.repeat(120); // > 80 cap
    const payload: ShowNotificationPayload = {
      sessionId: 's1',
      title: 'session is done',
      eventType: 'turn_done',
      extras: {
        toastId: 'done-1',
        sessionName: 'session',
        groupName: 'g',
        lastAssistantMsg: longMsg,
      },
    };
    showNotification(payload, null);
    expect(lastNotificationCtor).toBeDefined();
    // 80 cap, last char becomes ellipsis ⇒ length === 80 with U+2026.
    expect(lastNotificationCtor!.body.length).toBe(80);
    expect(lastNotificationCtor!.body.endsWith('\u2026')).toBe(true);
    expect(lastNotificationCtor!.body.startsWith('aaaa')).toBe(true);
  });

  it('legacy toast body unchanged when the host already supplied a body', () => {
    const payload: ShowNotificationPayload = {
      sessionId: 's1',
      title: 'session finished with an error',
      body: 'finished with an error',
      eventType: 'turn_done',
      extras: {
        toastId: 'done-2',
        sessionName: 'session',
        groupName: 'g',
        lastAssistantMsg: 'a long assistant trace that we DO NOT want to clobber the explicit body with',
      },
    };
    showNotification(payload, null);
    expect(lastNotificationCtor!.body).toBe('finished with an error');
  });

  it('adaptive toast done payload truncates lastAssistantMsg to 80 chars with ellipsis', async () => {
    const longMsg = 'b'.repeat(200);
    const payload: ShowNotificationPayload = {
      sessionId: 's1',
      title: 'done',
      eventType: 'turn_done',
      extras: {
        toastId: 'done-3',
        sessionName: 'session',
        groupName: 'group',
        lastAssistantMsg: longMsg,
        lastUserMsg: 'go',
        elapsedMs: 1234,
        toolCount: 2,
      },
    };
    showNotification(payload, null);
    // emitAdaptiveToast is fire-and-forget — flush the microtask queue.
    await new Promise((r) => setImmediate(r));
    expect(donePayloads.length).toBe(1);
    const done = donePayloads[0];
    expect((done.lastAssistantMsg as string).length).toBe(80);
    expect((done.lastAssistantMsg as string).endsWith('\u2026')).toBe(true);
    expect(done.groupName).toBe('group');
    expect(done.sessionName).toBe('session');
    expect(done.lastUserMsg).toBe('go');
    expect(done.elapsedMs).toBe(1234);
    expect(done.toolCount).toBe(2);
  });

  it('adaptive toast done payload passes through short messages untouched', async () => {
    const payload: ShowNotificationPayload = {
      sessionId: 's1',
      title: 'done',
      eventType: 'turn_done',
      extras: {
        toastId: 'done-4',
        sessionName: 'session',
        groupName: 'group',
        lastAssistantMsg: 'short reply',
      },
    };
    showNotification(payload, null);
    await new Promise((r) => setImmediate(r));
    expect(donePayloads[0].lastAssistantMsg).toBe('short reply');
  });

  it('question event schedules a single retry via the notify-retry seam', async () => {
    expect(__pendingRetryCountForTests()).toBe(0);
    showNotification(
      {
        sessionId: 's1',
        title: 'q',
        body: 'pick',
        eventType: 'question',
        extras: {
          toastId: 'q-req-1',
          sessionName: 'session',
          question: 'pick',
          selectionKind: 'single',
          optionCount: 2,
        },
      },
      null,
    );
    await new Promise((r) => setImmediate(r));
    expect(__pendingRetryCountForTests()).toBe(1);
  });
});
