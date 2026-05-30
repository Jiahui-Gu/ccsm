// src/mobile/mobilePage.ts
import type { Terminal } from '@xterm/xterm';
import type { SessionListEntry } from './protocol';
import type { PhoneUi } from './phoneApp';
import { createPhoneSignaling } from './phoneSignaling';
import { createPhonePeer } from './phonePeer';
import { wirePhoneApp } from './phoneApp';
import { readSessionToken } from './githubLogin';

/** The real xterm-backed PhoneUi (detail spec §6 "swap the pipe, keep the
 *  protocol"). DOM nodes + the Terminal are injected so this is unit-testable
 *  in plain Node; bootPhonePage() below builds the real ones from the page. */
export function createXtermPhoneUi(deps: {
  terminal: Terminal;
  sessionListEl: { replaceChildren: (...nodes: Node[]) => void };
  statusEl: { textContent: string | null };
  makeChip: (sid: string, label: string, active: boolean, onSelect: () => void) => Node;
  onSelect?: (sid: string) => void;
}): PhoneUi {
  return {
    renderSessions(sessions: SessionListEntry[], activeSid: string) {
      const chips = sessions.map((s) =>
        deps.makeChip(s.sid, s.cwd, s.sid === activeSid, () => deps.onSelect?.(s.sid)),
      );
      deps.sessionListEl.replaceChildren(...chips);
    },
    selectSession(_sid: string) { /* chip active state is re-derived on next renderSessions */ },
    write(chunk: string) { deps.terminal.write(chunk); },
    reset() { deps.terminal.reset(); },
    setStatus(status) { deps.statusEl.textContent = status; },
  };
}

/** Wire the real WebRTC phone client from the page URL. Called once on DOM
 *  ready by the bundled entry; everything it needs (token, peerId, DO url) is
 *  on `location`. The Worker put the session JWT on the URL after OAuth
 *  (githubLogin.ts). */
export function bootPhonePage(deps: {
  terminal: Terminal;
  sessionListEl: { replaceChildren: (...nodes: Node[]) => void };
  statusEl: { textContent: string | null };
  makeChip: (sid: string, label: string, active: boolean, onSelect: () => void) => Node;
  locationSearch: string;
  doUrl: string;
  iceServers: RTCIceServer[];
}): { close: () => void } | null {
  const token = readSessionToken(deps.locationSearch);
  if (!token) {
    deps.statusEl.textContent = 'not logged in';
    return null;
  }
  const peerId = `phone-${Math.random().toString(36).slice(2, 10)}`;
  const signaling = createPhoneSignaling({ url: `${deps.doUrl}?token=${encodeURIComponent(token)}`, peerId });
  const peer = createPhonePeer({ iceServers: deps.iceServers, signaling });

  const ui = createXtermPhoneUi(deps);
  const app = wirePhoneApp(peer, ui);
  (ui as { onSelect?: (sid: string) => void }).onSelect = app.select;

  deps.terminal.onData((data: string) => app.sendInput(data));
  return { close: () => app.close() };
}
