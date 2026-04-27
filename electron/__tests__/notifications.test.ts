// Tests for `electron/notifications.ts` after the W3 simplification.
//
// Behaviour locked in by W3:
//   - No Electron `Notification` cross-platform fallback. The only delivery
//     path is the inlined notify wrapper (`./notify`).
//   - Permission / question / turn_done dispatch into the wrapper based on
//     `payload.eventType`. Each call hands the wrapper a structured payload
//     plus registers a toastTarget so the action router can route activations
//     back to the right session.
//   - `shouldSuppressForFocus()` (main-process window focus de-dup) still
//     applies — that gate is *separate* from the deleted W1 renderer focus
//     gate. Spec note from W5: keep this gate, only the renderer gate was
//     removed.
//   - `eventType === 'test'` bypasses the focus suppression so a user-driven
//     "Send test notification" still fires when the window is focused.
//   - `dismissNotification` is a no-op when the wrapper is unavailable.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  showNotification,
  dismissNotification,
  type ShowNotificationPayload,
} from '../notifications';
import {
  configureNotify,
  __setNotifyImporter,
  probeNotifyAvailability,
} from '../notify';
import { __resetBootstrapForTests } from '../notify-bootstrap';

// Track which BrowserWindow.getAllWindows() value the test wants — flipped
// per-test so we can simulate focused vs unfocused without remocking.
let focusedWindowsForTest: Array<{
  isDestroyed: () => boolean;
  isFocused: () => boolean;
  isVisible: () => boolean;
}> = [];

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => focusedWindowsForTest,
  },
}));

type Call = { kind: 'permission' | 'question' | 'done' | 'dismiss'; payload: unknown };

async function installFakeNotifier(): Promise<Call[]> {
  const calls: Call[] = [];
  __setNotifyImporter(async () => ({
    Notifier: {
      create: async () => ({
        permission: (p: unknown) => calls.push({ kind: 'permission', payload: p }),
        question: (p: unknown) => calls.push({ kind: 'question', payload: p }),
        done: (p: unknown) => calls.push({ kind: 'done', payload: p }),
        dismiss: (id: string) => calls.push({ kind: 'dismiss', payload: id }),
      }),
    },
  }));
  configureNotify({ appId: 'test', appName: 'Test', onAction: () => {} });
  await probeNotifyAvailability();
  return calls;
}

describe('showNotification (post-W3, inlined-notify only)', () => {
  let calls: Call[];

  beforeEach(async () => {
    focusedWindowsForTest = []; // unfocused by default
    __resetBootstrapForTests();
    calls = await installFakeNotifier();
  });

  afterEach(() => {
    __setNotifyImporter(null);
  });

  it('routes a permission event into notifyPermission with the structured payload', async () => {
    const payload: ShowNotificationPayload = {
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
    };
    const fired = showNotification(payload, null);
    expect(fired).toBe(true);
    await new Promise((r) => setImmediate(r));

    const perm = calls.find((c) => c.kind === 'permission');
    expect(perm).toBeDefined();
    expect(perm!.payload).toMatchObject({
      toastId: 'req-1',
      sessionName: 'sess',
      toolName: 'Bash',
      toolBrief: 'ls -la',
      cwdBasename: 'proj',
    });
  });

  it('routes a question event into notifyQuestion', async () => {
    showNotification(
      {
        sessionId: 's1',
        title: 'g / sess',
        body: 'Question',
        eventType: 'question',
        extras: {
          toastId: 'q-req-2',
          sessionName: 'sess',
          groupName: 'g',
          question: 'Pick one',
          selectionKind: 'single',
          optionCount: 2,
          cwd: '/tmp/proj',
        },
      },
      null,
    );
    await new Promise((r) => setImmediate(r));
    const q = calls.find((c) => c.kind === 'question');
    expect(q).toBeDefined();
    expect(q!.payload).toMatchObject({
      toastId: 'q-req-2',
      sessionName: 'sess',
      question: 'Pick one',
      selectionKind: 'single',
      optionCount: 2,
    });
  });

  it('routes a turn_done event into notifyDone with truncated lastAssistantMsg (≤80)', async () => {
    const longMsg = 'x'.repeat(200);
    showNotification(
      {
        sessionId: 's1',
        title: 'g / sess',
        body: 'Turn done',
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
    const done = calls.find((c) => c.kind === 'done');
    expect(done).toBeDefined();
    const p = done!.payload as { lastAssistantMsg: string; groupName: string; toolCount: number };
    expect(p.lastAssistantMsg.length).toBe(80);
    expect(p.lastAssistantMsg.endsWith('…')).toBe(true);
    expect(p.groupName).toBe('g');
    expect(p.toolCount).toBe(3);
  });

  it('passes through a short lastAssistantMsg untouched', async () => {
    showNotification(
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
    const done = calls.find((c) => c.kind === 'done');
    expect((done!.payload as { lastAssistantMsg: string }).lastAssistantMsg).toBe('short reply');
  });

  it('suppresses (returns false, no wrapper call) when a window is focused and visible', async () => {
    focusedWindowsForTest = [
      {
        isDestroyed: () => false,
        isFocused: () => true,
        isVisible: () => true,
      },
    ];
    const fired = showNotification(
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
    expect(calls.find((c) => c.kind === 'permission')).toBeUndefined();
  });

  it("eventType === 'test' bypasses the main-process focus suppression", async () => {
    focusedWindowsForTest = [
      {
        isDestroyed: () => false,
        isFocused: () => true,
        isVisible: () => true,
      },
    ];
    const fired = showNotification(
      {
        sessionId: 's1',
        title: 'g / sess',
        eventType: 'test',
        extras: { toastId: 't-test', sessionName: 'sess', groupName: 'g' },
      },
      null,
    );
    // The 'test' branch bypasses focus suppression but the switch in
    // emitAdaptiveToast doesn't have a `test` case — so showNotification
    // returns true (passed the focus gate) but no wrapper call is emitted.
    expect(fired).toBe(true);
  });

  it('returns false when the wrapper is unavailable (no notify-impl loaded)', async () => {
    __setNotifyImporter(async () => {
      throw new Error('module missing');
    });
    // Suppress the wrapper warning during the unavailability flip.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Re-probe so isNotifyAvailable flips back to false.
    await probeNotifyAvailability();
    const fired = showNotification(
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
  beforeEach(() => {
    focusedWindowsForTest = [];
    __resetBootstrapForTests();
  });

  afterEach(() => {
    __setNotifyImporter(null);
  });

  it('is a no-op when the wrapper is unavailable (does not throw)', async () => {
    __setNotifyImporter(async () => {
      throw new Error('module missing');
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await probeNotifyAvailability();
    await expect(dismissNotification('toast-x')).resolves.toBeUndefined();
  });

  it('forwards to wrapper.dismiss when the wrapper is loaded', async () => {
    const calls = await installFakeNotifier();
    await dismissNotification('toast-y');
    const dismiss = calls.find((c) => c.kind === 'dismiss');
    expect(dismiss).toBeDefined();
    expect(dismiss!.payload).toBe('toast-y');
  });
});
