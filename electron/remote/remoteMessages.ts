import {
  getBufferSnapshot,
  getPtySession,
  inputPtySession,
  listPtySessions,
  submitPtySession,
} from '../ptyHost';
import {
  MAX_MOBILE_SUBMIT_CHARS,
  type MobileServerMessage as SharedMobileServerMessage,
  type SessionListEntry,
} from '../../src/shared/mobileRemote';
import { SESSION_NAVIGATOR_MESSAGE_VERSION } from '../../src/shared/sessionNavigator';
import { readRemoteNavigationModel } from './navigationSource';
import { isRecord } from './remoteHttp';
import type { RemotePeer } from './remotePeer';

/** The session-chip payload the mobile client renders: just the identity and
 *  size it needs. We deliberately omit `pid` — it is noise on the wire and the
 *  client never uses it. */
export type MobileServerMessage =
  | { type: 'auth.ok' }
  | SharedMobileServerMessage;

export function listEntries(): SessionListEntry[] {
  return listPtySessions().map((s) => ({ sid: s.sid, cwd: s.cwd, cols: s.cols, rows: s.rows }));
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

  if (!isRecord(message) || typeof message.type !== 'string') {
    client.send({ type: 'error', message: 'invalid_message' });
    return;
  }

  if (message.type === 'sessions.list') {
    sendSessionCatalog(client);
    return;
  }

  if (message.type === 'session.snapshot') {
    if (typeof message.sid !== 'string') {
      client.send({ type: 'error', message: 'missing_sid' });
      return;
    }
    // session.snapshot is the client's "select this session" signal. Record it
    // so the pty.data broadcast only forwards this session's bytes to this
    // client (see the onPtyData gate above).
    client.subscribedSid = message.sid;
    const snapshot = await getBufferSnapshot(message.sid);
    const info = getPtySession(message.sid);
    client.send({
      type: 'session.snapshot',
      sid: message.sid,
      cols: info?.cols ?? null,
      rows: info?.rows ?? null,
      ...snapshot,
    });
    return;
  }

  if (message.type === 'session.input') {
    if (typeof message.sid !== 'string' || typeof message.data !== 'string') {
      client.send({ type: 'error', message: 'invalid_input' });
      return;
    }
    inputPtySession(message.sid, message.data);
    return;
  }

  // Acknowledged complete-draft submission (mobile composer). Unlike
  // `session.input` (fire-and-forget keystroke relay, best-effort `error`
  // on malformed shape), a submission is correlated by `requestId` so the
  // phone can resolve/reject its pending Send button. Malformed fields get
  // exactly ONE `session.submit.result` failure and the PTY is never
  // touched; valid fields call `submitPtySession` exactly once and map its
  // explicit `PtySubmitResult` 1:1 onto the response — no broad catch, no
  // silent success fallback.
  if (message.type === 'session.submit') {
    // Preserve whatever valid string sid/requestId exists so the failure
    // response stays typed and serializable even when the OTHER field (or
    // the draft) is what failed validation; empty string when the field
    // itself isn't a valid non-empty string.
    const sid = typeof message.sid === 'string' ? message.sid : '';
    const requestId = typeof message.requestId === 'string' ? message.requestId : '';
    const sidValid = typeof message.sid === 'string' && message.sid.length > 0;
    const requestIdValid = typeof message.requestId === 'string' && message.requestId.length > 0;
    const draftValid =
      typeof message.draft === 'string' &&
      message.draft.length > 0 &&
      message.draft.length <= MAX_MOBILE_SUBMIT_CHARS;

    if (!sidValid || !requestIdValid || !draftValid) {
      client.send({
        type: 'session.submit.result',
        sid,
        requestId,
        ok: false,
        error: 'invalid_submission',
      });
      return;
    }

    const result = submitPtySession(message.sid as string, message.draft as string);
    if (result === 'ok') {
      client.send({ type: 'session.submit.result', sid, requestId, ok: true });
      return;
    }
    client.send({ type: 'session.submit.result', sid, requestId, ok: false, error: result });
    return;
  }

  if (message.type === 'session.resize') {
    if (
      typeof message.sid !== 'string' ||
      !Number.isInteger(message.cols) ||
      !Number.isInteger(message.rows)
    ) {
      client.send({ type: 'error', message: 'invalid_resize' });
      return;
    }
    // Compatibility with already-deployed phone clients. Phone viewports are
    // projections of the desktop-owned terminal and must never resize the
    // shared PTY/headless buffer.
    return;
  }

  client.send({ type: 'error', message: 'unknown_type' });
}
