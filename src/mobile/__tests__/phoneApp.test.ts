// src/mobile/__tests__/phoneApp.test.ts
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { wirePhoneApp } from '../phoneApp';
import type { DesktopToPhone, PhoneToDesktop } from '../protocol';

/** A fake phonePeer: lets the test push inbound messages and capture sends. */
function fakePeer() {
  let msgCb: ((m: DesktopToPhone) => void) | null = null;
  let openCb: (() => void) | null = null;
  const sent: PhoneToDesktop[] = [];
  return {
    peer: {
      send: (m: PhoneToDesktop) => sent.push(m),
      onMessage: (cb: (m: DesktopToPhone) => void) => { msgCb = cb; },
      onOpen: (cb: () => void) => { openCb = cb; },
      close: () => {},
    },
    push: (m: DesktopToPhone) => msgCb?.(m),
    fireOpen: () => openCb?.(),
    sent,
  };
}

function fakeUi() {
  return {
    renderSessions: vi.fn(),
    selectSession: vi.fn(),
    write: vi.fn(),
    reset: vi.fn(),
    setStatus: vi.fn(),
  };
}

describe('wirePhoneApp', () => {
  it('on open, sets status and requests the session list', () => {
    const f = fakePeer();
    const ui = fakeUi();
    wirePhoneApp(f.peer, ui);
    f.fireOpen();
    expect(ui.setStatus).toHaveBeenCalledWith('connected');
    expect(f.sent).toContainEqual({ type: 'sessions.list' });
  });

  it('renders sessions.list and auto-selects the first session', () => {
    const f = fakePeer();
    const ui = fakeUi();
    wirePhoneApp(f.peer, ui);
    f.push({ type: 'sessions.list', sessions: [
      { sid: 's1', cwd: '/a', cols: 80, rows: 24 },
      { sid: 's2', cwd: '/b', cols: 80, rows: 24 },
    ]});
    expect(ui.renderSessions).toHaveBeenCalled();
    expect(ui.selectSession).toHaveBeenCalledWith('s1');
    // selecting requests a snapshot
    expect(f.sent).toContainEqual({ type: 'session.snapshot', sid: 's1' });
  });

  it('paints a snapshot then live pty.data, dropping chunks already in the snapshot', () => {
    const f = fakePeer();
    const ui = fakeUi();
    const app = wirePhoneApp(f.peer, ui);
    f.push({ type: 'sessions.list', sessions: [{ sid: 's1', cwd: '/a', cols: 80, rows: 24 }] });
    f.push({ type: 'session.snapshot', sid: 's1', cols: 80, rows: 24, snapshot: 'HELLO', seq: 5 });
    expect(ui.reset).toHaveBeenCalled();
    expect(ui.write).toHaveBeenCalledWith('HELLO');
    // seq <= snapshot seq is already baked in → dropped
    f.push({ type: 'pty.data', sid: 's1', chunk: 'old', seq: 5 });
    // seq > snapshot seq → painted
    f.push({ type: 'pty.data', sid: 's1', chunk: 'new', seq: 6 });
    expect(ui.write).not.toHaveBeenCalledWith('old');
    expect(ui.write).toHaveBeenCalledWith('new');
    void app;
  });

  it('forwards input and resize to the peer', () => {
    const f = fakePeer();
    const ui = fakeUi();
    const app = wirePhoneApp(f.peer, ui);
    f.push({ type: 'sessions.list', sessions: [{ sid: 's1', cwd: '/a', cols: 80, rows: 24 }] });
    app.sendInput('ls\r');
    app.sendResize(100, 40);
    expect(f.sent).toContainEqual({ type: 'session.input', sid: 's1', data: 'ls\r' });
    expect(f.sent).toContainEqual({ type: 'session.resize', sid: 's1', cols: 100, rows: 40 });
  });

  it('ignores pty.data / snapshot for a non-active session', () => {
    const f = fakePeer();
    const ui = fakeUi();
    wirePhoneApp(f.peer, ui);
    f.push({ type: 'sessions.list', sessions: [{ sid: 's1', cwd: '/a', cols: 80, rows: 24 }] });
    ui.write.mockClear();
    f.push({ type: 'pty.data', sid: 'OTHER', chunk: 'z', seq: 9 });
    expect(ui.write).not.toHaveBeenCalled();
  });

  it('surfaces an inbound error message (reviewer P3 #1)', () => {
    const f = fakePeer();
    const ui = fakeUi();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    wirePhoneApp(f.peer, ui);
    f.push({ type: 'error', message: 'invalid_resize' });
    expect(warn).toHaveBeenCalledWith('[phone] desktop error:', 'invalid_resize');
    warn.mockRestore();
  });
});
