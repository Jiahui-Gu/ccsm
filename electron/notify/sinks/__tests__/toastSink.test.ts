// Tests for createToastSink — the OS-notification executor in the notify
// pipeline. The sink takes a Decision from notifyDecider and:
//   1. Resolves the user-visible name via getNameFn (placeholder/empty
//      collapse to short sid prefix).
//   2. Calls toastImpl.show with the i18n title/body + a click handler that
//      focuses the window + sends 'session:activate'.
//   3. Bumps the unread badge via onNotified.
//
// We assert real behavior by injecting a recording toastImpl (no real
// Notification spawn) and a stub BrowserWindow.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// electron is statically imported for `Notification` and the BrowserWindow
// type. Mock it so importing the sink doesn't require an Electron runtime.
vi.mock('electron', () => ({
  Notification: class {
    static isSupported() {
      return false;
    }
  },
  BrowserWindow: class {},
}));

import { createToastSink, type ToastImpl, type ToastPayload } from '../toastSink';
import type { Decision } from '../../notifyDecider';
import { tNotification } from '../../../i18n';

interface ShowCall {
  payload: ToastPayload;
  onClick: () => void;
}

function makeRecordingImpl(): { impl: ToastImpl; calls: ShowCall[] } {
  const calls: ShowCall[] = [];
  const impl: ToastImpl = {
    show(payload, onClick) {
      calls.push({ payload, onClick });
    },
  };
  return { impl, calls };
}

interface StubWin {
  isDestroyed: () => boolean;
  isVisible: () => boolean;
  isMinimized: () => boolean;
  show: ReturnType<typeof vi.fn>;
  restore: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  webContents: {
    isDestroyed: () => boolean;
    send: ReturnType<typeof vi.fn>;
  };
}

function makeStubWin(opts: { destroyed?: boolean; visible?: boolean; minimized?: boolean } = {}): StubWin {
  return {
    isDestroyed: () => Boolean(opts.destroyed),
    isVisible: () => opts.visible ?? true,
    isMinimized: () => Boolean(opts.minimized),
    show: vi.fn(),
    restore: vi.fn(),
    focus: vi.fn(),
    webContents: {
      isDestroyed: () => false,
      send: vi.fn(),
    },
  };
}

function dec(sid: string, toast: boolean, flash = false): Decision {
  return { sid, toast, flash };
}

describe('createToastSink', () => {
  beforeEach(() => {
    delete process.env.CCSM_NOTIFY_TEST_HOOK;
  });

  it('does nothing when decision.toast is false', () => {
    const { impl, calls } = makeRecordingImpl();
    const sink = createToastSink({ getMainWindow: () => null, toastImpl: impl });
    sink.apply(dec('s1', false));
    expect(calls).toEqual([]);
  });

  it('builds payload with i18n title/body and the resolved name', () => {
    const { impl, calls } = makeRecordingImpl();
    const sink = createToastSink({
      getMainWindow: () => null,
      getNameFn: () => 'My Session',
      toastImpl: impl,
    });
    const before = Date.now();
    sink.apply(dec('s1', true, true));
    const after = Date.now();
    expect(calls.length).toBe(1);
    const p = calls[0]!.payload;
    expect(p.sid).toBe('s1');
    expect(p.state).toBe('requires_action');
    expect(p.title).toBe(tNotification('sessionWaitingTitle'));
    expect(p.body).toBe(tNotification('sessionWaitingBody', { name: 'My Session' }));
    expect(p.body).toContain('My Session');
    expect(p.decision).toEqual({ sid: 's1', toast: true, flash: true });
    expect(p.ts).toBeGreaterThanOrEqual(before);
    expect(p.ts).toBeLessThanOrEqual(after);
  });

  it('falls back to short sid (first 8 chars) when name is null/empty/placeholder', () => {
    const longSid = 'abcdef0123456789-tail';
    const cases: Array<string | null | undefined> = [
      null,
      undefined,
      '',
      '   ',
      'new session',
      'NEW SESSION',
      '新会话',
    ];
    for (const name of cases) {
      const { impl, calls } = makeRecordingImpl();
      const sink = createToastSink({
        getMainWindow: () => null,
        getNameFn: () => name,
        toastImpl: impl,
      });
      sink.apply(dec(longSid, true));
      expect(calls[0]!.payload.body).toContain('abcdef01');
    }
  });

  it('uses sid verbatim when sid is shorter than 8 chars', () => {
    const { impl, calls } = makeRecordingImpl();
    const sink = createToastSink({
      getMainWindow: () => null,
      getNameFn: () => null,
      toastImpl: impl,
    });
    sink.apply(dec('abc', true));
    expect(calls[0]!.payload.body).toContain('abc');
  });

  it('trims whitespace from the resolved name', () => {
    const { impl, calls } = makeRecordingImpl();
    const sink = createToastSink({
      getMainWindow: () => null,
      getNameFn: () => '  Trimmed  ',
      toastImpl: impl,
    });
    sink.apply(dec('s1', true));
    expect(calls[0]!.payload.body).toContain('Trimmed');
    expect(calls[0]!.payload.body).not.toContain('  Trimmed');
  });

  it('click handler focuses, restores when minimized, shows when hidden, and sends session:activate', () => {
    const { impl, calls } = makeRecordingImpl();
    const win = makeStubWin({ visible: false, minimized: true });
    const sink = createToastSink({
      getMainWindow: () => win as never,
      getNameFn: () => 'X',
      toastImpl: impl,
    });
    sink.apply(dec('s1', true));
    calls[0]!.onClick();
    expect(win.show).toHaveBeenCalledTimes(1);
    expect(win.restore).toHaveBeenCalledTimes(1);
    expect(win.focus).toHaveBeenCalledTimes(1);
    expect(win.webContents.send).toHaveBeenCalledWith('session:activate', { sid: 's1' });
  });

  it('click handler skips show/restore when window already visible+not-minimized', () => {
    const { impl, calls } = makeRecordingImpl();
    const win = makeStubWin({ visible: true, minimized: false });
    const sink = createToastSink({
      getMainWindow: () => win as never,
      toastImpl: impl,
    });
    sink.apply(dec('s1', true));
    calls[0]!.onClick();
    expect(win.show).not.toHaveBeenCalled();
    expect(win.restore).not.toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalled();
  });

  it('click handler is a no-op when window is null or destroyed', () => {
    const { impl, calls } = makeRecordingImpl();
    const sink = createToastSink({ getMainWindow: () => null, toastImpl: impl });
    sink.apply(dec('s1', true));
    expect(() => calls[0]!.onClick()).not.toThrow();

    const { impl: impl2, calls: calls2 } = makeRecordingImpl();
    const win = makeStubWin({ destroyed: true });
    const sink2 = createToastSink({ getMainWindow: () => win as never, toastImpl: impl2 });
    sink2.apply(dec('s1', true));
    calls2[0]!.onClick();
    expect(win.focus).not.toHaveBeenCalled();
  });

  it('calls onNotified after a successful toast', () => {
    const { impl } = makeRecordingImpl();
    const onNotified = vi.fn();
    const sink = createToastSink({
      getMainWindow: () => null,
      toastImpl: impl,
      onNotified,
    });
    sink.apply(dec('s1', true));
    expect(onNotified).toHaveBeenCalledWith('s1');
  });

  it('does NOT call onNotified when the decision is suppressed', () => {
    const { impl } = makeRecordingImpl();
    const onNotified = vi.fn();
    const sink = createToastSink({
      getMainWindow: () => null,
      toastImpl: impl,
      onNotified,
    });
    sink.apply(dec('s1', false));
    expect(onNotified).not.toHaveBeenCalled();
  });

  it('swallows errors thrown by onNotified (does not propagate)', () => {
    const { impl } = makeRecordingImpl();
    const sink = createToastSink({
      getMainWindow: () => null,
      toastImpl: impl,
      onNotified: () => {
        throw new Error('boom');
      },
    });
    expect(() => sink.apply(dec('s1', true))).not.toThrow();
  });

  it('uses test-hook impl when CCSM_NOTIFY_TEST_HOOK is set and no impl provided', () => {
    process.env.CCSM_NOTIFY_TEST_HOOK = '1';
    const g = globalThis as unknown as {
      __ccsmNotifyLog?: Array<{ sid: string; state: string; title: string; body: string }>;
    };
    g.__ccsmNotifyLog = [];
    const sink = createToastSink({
      getMainWindow: () => null,
      getNameFn: () => 'Probe',
    });
    sink.apply(dec('s1', true));
    expect(g.__ccsmNotifyLog!.length).toBe(1);
    expect(g.__ccsmNotifyLog![0]!.sid).toBe('s1');
    expect(g.__ccsmNotifyLog![0]!.state).toBe('requires_action');
  });
});
