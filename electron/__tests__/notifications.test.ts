// Tests for `electron/notifications.ts` after the Electron-Notification swap.
//
// Behaviour locked in:
//   - `showNotification` routes permission / question / turn_done events into
//     the corresponding wrapper function, which constructs an Electron
//     `Notification` with title + body composed from the structured payload.
//   - `shouldSuppressForFocus()` (main-process window focus de-dup) suppresses
//     emission when any visible window is focused.
//   - `eventType === 'test'` bypasses the focus suppression.
//   - `dismissNotification` calls `notification.close()` on the live toast,
//     and is a no-op when no toast is registered for that id.
//
// We mock `electron` so:
//   - `Notification.isSupported()` returns true (or false when we want to
//     simulate an unsupported host).
//   - `new Notification(...)` records the constructor args + returns a fake
//     handle whose `show()`, `close()`, and `on()` calls are captured.
//
// `vi.resetModules()` runs before each test so the per-module Notification
// state in `electron/notify.ts` (live-toast Map, last error) starts clean.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type CtorOpts = { title?: string; body?: string; silent?: boolean; icon?: string };
type FakeNotif = {
  opts: CtorOpts;
  show: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  handlers: Record<string, () => void>;
};

let isSupportedForTest = true;
let focusedWindowsForTest: Array<{
  isDestroyed: () => boolean;
  isFocused: () => boolean;
  isVisible: () => boolean;
}> = [];
const notifications: FakeNotif[] = [];

vi.mock('electron', () => {
  class FakeNotification {
    static isSupported(): boolean {
      return isSupportedForTest;
    }
    handlers: Record<string, () => void> = {};
    constructor(public opts: CtorOpts) {
      const fake: FakeNotif = {
        opts,
        show: vi.fn(),
        close: vi.fn(),
        on: vi.fn((evt: string, cb: () => void) => {
          this.handlers[evt] = cb;
          fake.handlers[evt] = cb;
        }),
        handlers: this.handlers,
      };
      // Bridge the instance methods to the recorded fake so test code can
      // both spy on calls and trigger 'click' / 'close' handlers manually.
      (this as unknown as { show: typeof fake.show }).show = fake.show;
      (this as unknown as { close: typeof fake.close }).close = fake.close;
      (this as unknown as { on: typeof fake.on }).on = fake.on;
      notifications.push(fake);
    }
  }
  return {
    Notification: FakeNotification,
    BrowserWindow: {
      getAllWindows: () => focusedWindowsForTest,
    },
  };
});

// Import AFTER vi.mock so the modules get the fake `electron`.
async function freshModules(): Promise<{
  showNotification: typeof import('../notifications').showNotification;
  dismissNotification: typeof import('../notifications').dismissNotification;
  configureNotify: typeof import('../notify').configureNotify;
  resetBootstrap: typeof import('../notify-bootstrap').__resetBootstrapForTests;
}> {
  vi.resetModules();
  const notif = await import('../notifications');
  const notify = await import('../notify');
  const bootstrap = await import('../notify-bootstrap');
  return {
    showNotification: notif.showNotification,
    dismissNotification: notif.dismissNotification,
    configureNotify: notify.configureNotify,
    resetBootstrap: bootstrap.__resetBootstrapForTests,
  };
}

describe('showNotification (Electron Notification path)', () => {
  let mods: Awaited<ReturnType<typeof freshModules>>;

  beforeEach(async () => {
    isSupportedForTest = true;
    focusedWindowsForTest = [];
    notifications.length = 0;
    mods = await freshModules();
    mods.resetBootstrap();
    mods.configureNotify({ appId: 'test', appName: 'Test', onAction: () => {} });
  });

  afterEach(() => {
    notifications.length = 0;
  });

  it('routes a permission event into Notification with structured title/body', async () => {
    const fired = mods.showNotification(
      {
        sessionId: 's1',
        title: 'g / sess',
        body: 'Permission',
        eventType: 'permission',
        extras: {
          toastId: 'req-1',
          sessionName: 'sess',
          groupName: 'g',
          toolName: 'Bash',
          toolBrief: 'ls -la',
          cwd: '/tmp/proj',
        },
      },
      null,
    );
    expect(fired).toBe(true);
    await new Promise((r) => setImmediate(r));
    expect(notifications).toHaveLength(1);
    const n = notifications[0];
    expect(n.opts.title).toBe('Permission needed: Bash');
    expect(n.opts.body).toContain('sess');
    expect(n.opts.body).toContain('ls -la');
    expect(n.opts.body).toContain('proj');
    expect(n.show).toHaveBeenCalled();
  });

  it('routes a question event into Notification (body truncated to 200 chars)', async () => {
    const longQuestion = 'q'.repeat(400);
    mods.showNotification(
      {
        sessionId: 's1',
        title: 'g / sess',
        eventType: 'question',
        extras: {
          toastId: 'q-req-2',
          sessionName: 'sess',
          groupName: 'g',
          question: longQuestion,
          selectionKind: 'single',
          optionCount: 2,
          cwd: '/tmp/proj',
        },
      },
      null,
    );
    await new Promise((r) => setImmediate(r));
    expect(notifications).toHaveLength(1);
    const n = notifications[0];
    expect(n.opts.title).toBe('Question: sess');
    expect(n.opts.body!.length).toBe(200);
    expect(n.opts.body!.endsWith('…')).toBe(true);
  });

  it('routes a turn_done event with truncated lastAssistantMsg (≤80)', async () => {
    const longMsg = 'x'.repeat(200);
    mods.showNotification(
      {
        sessionId: 's1',
        title: 'g / sess',
        eventType: 'turn_done',
        extras: {
          toastId: 'done-1',
          sessionName: 'sess',
          groupName: 'g',
          lastUserMsg: 'go',
          lastAssistantMsg: longMsg,
          elapsedMs: 1234,
          toolCount: 3,
          cwd: '/tmp/proj',
        },
      },
      null,
    );
    await new Promise((r) => setImmediate(r));
    expect(notifications).toHaveLength(1);
    const n = notifications[0];
    expect(n.opts.title).toBe('g / sess');
    // Body has both user + assistant lines.
    expect(n.opts.body).toContain('> go');
    // Assistant slice is truncated to 80.
    const assistantLine = n.opts.body!.split('\n')[1];
    expect(assistantLine.length).toBe(80);
    expect(assistantLine.endsWith('…')).toBe(true);
  });

  it('passes through a short lastAssistantMsg untouched', async () => {
    mods.showNotification(
      {
        sessionId: 's1',
        title: 'g / sess',
        eventType: 'turn_done',
        extras: {
          toastId: 'done-2',
          sessionName: 'sess',
          groupName: 'g',
          lastAssistantMsg: 'short reply',
        },
      },
      null,
    );
    await new Promise((r) => setImmediate(r));
    expect(notifications).toHaveLength(1);
    expect(notifications[0].opts.body).toContain('short reply');
  });

  it('suppresses (returns false, no Notification ctor) when a window is focused', async () => {
    focusedWindowsForTest = [
      {
        isDestroyed: () => false,
        isFocused: () => true,
        isVisible: () => true,
      },
    ];
    const fired = mods.showNotification(
      {
        sessionId: 's1',
        title: 'g / sess',
        eventType: 'permission',
        extras: {
          toastId: 'req-suppressed',
          sessionName: 'sess',
          groupName: 'g',
          toolName: 'Bash',
          toolBrief: 'ls',
        },
      },
      null,
    );
    expect(fired).toBe(false);
    await new Promise((r) => setImmediate(r));
    expect(notifications).toHaveLength(0);
  });

  it("eventType === 'test' bypasses the focus suppression and fires a Notification", async () => {
    focusedWindowsForTest = [
      {
        isDestroyed: () => false,
        isFocused: () => true,
        isVisible: () => true,
      },
    ];
    const fired = mods.showNotification(
      {
        sessionId: 's1',
        title: 'g / sess',
        eventType: 'test',
        extras: { toastId: 't-test', sessionName: 'sess', groupName: 'g' },
      },
      null,
    );
    expect(fired).toBe(true);
    await new Promise((r) => setImmediate(r));
    expect(notifications).toHaveLength(1);
    expect(notifications[0].opts.title).toBe('CCSM test notification');
    expect(notifications[0].opts.body).toContain('If you can see this');
  });

  it('returns false when Notification.isSupported() reports false', async () => {
    isSupportedForTest = false;
    // Re-import so the wrapper picks up the new isSupported() value.
    mods = await freshModules();
    mods.resetBootstrap();
    mods.configureNotify({ appId: 'test', appName: 'Test', onAction: () => {} });
    const fired = mods.showNotification(
      {
        sessionId: 's1',
        title: 't',
        eventType: 'permission',
        extras: { toastId: 'r1', sessionName: 's', groupName: 'g', toolName: 'Bash', toolBrief: 'ls' },
      },
      null,
    );
    expect(fired).toBe(false);
  });
});

describe('dismissNotification', () => {
  let mods: Awaited<ReturnType<typeof freshModules>>;

  beforeEach(async () => {
    isSupportedForTest = true;
    focusedWindowsForTest = [];
    notifications.length = 0;
    mods = await freshModules();
    mods.resetBootstrap();
    mods.configureNotify({ appId: 'test', appName: 'Test', onAction: () => {} });
  });

  it('is a no-op when no toast is registered (does not throw)', async () => {
    await expect(mods.dismissNotification('toast-x')).resolves.toBeUndefined();
  });

  it('closes the live Notification when one was emitted for the toastId', async () => {
    mods.showNotification(
      {
        sessionId: 's1',
        title: 'g / sess',
        eventType: 'turn_done',
        extras: { toastId: 'done-y', sessionName: 'sess', groupName: 'g', lastAssistantMsg: 'reply' },
      },
      null,
    );
    await new Promise((r) => setImmediate(r));
    expect(notifications).toHaveLength(1);
    await mods.dismissNotification('done-y');
    expect(notifications[0].close).toHaveBeenCalled();
  });
});
