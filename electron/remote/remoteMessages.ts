import {
  getCoordinatedSnapshot,
  inputPtySession,
  listPtySessions,
  submitPtySession,
} from '../ptyHost';
import {
  isMobileClientMessage,
  type MobileServerMessage as SharedMobileServerMessage,
  type SessionListEntry,
} from '../../src/shared/mobileRemote';
import { SESSION_NAVIGATOR_MESSAGE_VERSION } from '../../src/shared/sessionNavigator';
import { readRemoteNavigationModel } from './navigationSource';
import type { RemotePeer } from './remotePeer';

/** The session-chip payload the mobile client renders: just the identity and
 *  size it needs. We deliberately omit `pid` — it is noise on the wire and the
 *  client never uses it. */
export type MobileServerMessage =
  | { type: 'auth.ok' }
  | SharedMobileServerMessage;

export function listEntries(): SessionListEntry[] {
  return listPtySessions().map((s) => ({ sid: s.sid, cwd: s.cwd, geometry: s.geometry }));
}

/** A cheap fingerprint of the session list used by the server poll loop to
 *  decide whether to re-broadcast. Only identity matters for the chip list —
 *  cols/rows churn constantly as terminals resize and would cause needless
 *  sessions.list spam. */
export function listSignature(entries: SessionListEntry[]): string {
  return entries.map((e) => `${e.sid}:${e.cwd}`).join('|');
}

export function sendSessionCatalog(peer: { send(payload: MobileServerMessage): void }): void {
  peer.send({ type: 'sessions.list', sessions: listEntries() });
  peer.send({
    type: 'sessions.navigator',
    version: SESSION_NAVIGATOR_MESSAGE_VERSION,
    model: readRemoteNavigationModel(),
  });
}

export async function handleClientMessage(client: RemotePeer, raw: string): Promise<void> {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    client.send({ type: 'error', message: 'invalid_json' });
    return;
  }

  if (!isMobileClientMessage(message)) {
    client.send({ type: 'error', message: 'invalid_message' });
    return;
  }

  if (message.type === 'sessions.list') {
    sendSessionCatalog(client);
    return;
  }

  if (message.type === 'session.snapshot') {
    client.subscribedSid = message.sid;
    const snapshot = await getCoordinatedSnapshot(message.sid);
    if (!snapshot) {
      if (client.subscribedSid === message.sid) client.subscribedSid = null;
      client.send({ type: 'error', message: 'missing_sid' });
      return;
    }
    // session.snapshot is the client's "select this session" signal. Record it
    // so the pty.data broadcast only forwards this session's bytes to this
    // client through the ordered terminal publication gate.
    client.send(snapshot);
    return;
  }

  if (message.type === 'session.input') {
    inputPtySession(message.sid, message.data, { kind: 'mobile-control' });
    return;
  }

  // Acknowledged complete-draft submission (mobile composer). Message shape is
  // already protocol-validated; we only map the PTY lifecycle result to one
  // correlated `session.submit.result`.
  if (message.type === 'session.submit') {
    const result = await submitPtySession(message.sid, message.draft);
    if (result === 'ok') {
      client.send({ type: 'session.submit.result', sid: message.sid, requestId: message.requestId, ok: true });
      return;
    }
    client.send({
      type: 'session.submit.result',
      sid: message.sid,
      requestId: message.requestId,
      ok: false,
      error: result,
    });
    return;
  }

  client.send({ type: 'error', message: 'invalid_message' });
}
