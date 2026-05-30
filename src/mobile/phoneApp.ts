// src/mobile/phoneApp.ts
import type { DesktopToPhone, PhoneToDesktop, SessionListEntry } from './protocol';

type PhonePeer = {
  send: (msg: PhoneToDesktop) => void;
  onMessage: (cb: (msg: DesktopToPhone) => void) => void;
  onOpen: (cb: () => void) => void;
  close: () => void;
};

/** The UI port the xterm layer exposes. Keeping it abstract lets the wiring be
 *  tested without a real DOM/xterm; mobilePage.ts implements it against the
 *  actual Terminal in PR-4. */
export type PhoneUi = {
  renderSessions: (sessions: SessionListEntry[], activeSid: string) => void;
  selectSession: (sid: string) => void;
  write: (chunk: string) => void;
  reset: () => void;
  setStatus: (status: 'connecting' | 'connected' | 'reconnecting') => void;
};

/** Drive the xterm UI from a phonePeer's message stream — the DataChannel
 *  analogue of mobilePage.ts's `ws.onmessage`. Protocol unchanged: this is the
 *  "swap the pipe, keep the protocol" wiring (detail spec §6). */
export function wirePhoneApp(peer: PhonePeer, ui: PhoneUi) {
  let activeSid = '';
  // Live pty.data chunks with seq <= snapSeq are already in the snapshot we
  // painted; drop them to avoid double-paint (mirrors mobilePage.ts).
  let snapSeq = -1;

  function select(sid: string) {
    activeSid = sid;
    snapSeq = -1;
    ui.selectSession(sid);
    ui.reset();
    peer.send({ type: 'session.snapshot', sid });
  }

  peer.onOpen(() => {
    ui.setStatus('connected');
    // The PR-2 answerer pushes `sessions.list` unsolicited on channel open AND
    // we request it here, so the phone receives the list twice on connect. That
    // is harmless/idempotent (auto-select only fires while !activeSid) — do not
    // "fix" the duplicate. (Reviewer P3 #2.)
    peer.send({ type: 'sessions.list' });
  });

  peer.onMessage((msg) => {
    if (msg.type === 'sessions.list') {
      ui.renderSessions(msg.sessions, activeSid);
      if (!activeSid && msg.sessions.length) select(msg.sessions[0]!.sid);
      return;
    }
    if (msg.type === 'session.snapshot' && msg.sid === activeSid) {
      ui.reset();
      ui.write(msg.snapshot || '');
      snapSeq = Number.isInteger(msg.seq) ? msg.seq : -1;
      return;
    }
    if (msg.type === 'pty.data' && msg.sid === activeSid) {
      if (Number.isInteger(msg.seq) && msg.seq <= snapSeq) return;
      ui.write(msg.chunk || '');
      return;
    }
    if (msg.type === 'error') {
      // Surface desktop-side protocol errors so they are observable on the
      // phone rather than silently dropped. (Reviewer P3 #1.)
      console.warn('[phone] desktop error:', msg.message);
      return;
    }
  });

  return {
    select,
    sendInput: (data: string) => {
      if (activeSid) peer.send({ type: 'session.input', sid: activeSid, data });
    },
    sendResize: (cols: number, rows: number) => {
      if (activeSid) peer.send({ type: 'session.resize', sid: activeSid, cols, rows });
    },
    close: () => peer.close(),
  };
}
