import {
  getBufferSnapshot,
  getPtySession,
  inputPtySession,
  listPtySessions,
  resizePtySession,
} from '../ptyHost';
import { isRecord } from './remoteHttp';
import type { WsClient } from './wsProtocol';

/** The session-chip payload the mobile client renders: just the identity and
 *  size it needs. We deliberately omit `pid` — it is noise on the wire and the
 *  client never uses it. */
export type SessionListEntry = {
  sid: string;
  cwd: string;
  cols: number;
  rows: number;
};

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

export async function handleClientMessage(client: WsClient, raw: string): Promise<void> {
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
    client.send({ type: 'sessions.list', sessions: listEntries() });
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

  if (message.type === 'session.resize') {
    if (
      typeof message.sid !== 'string' ||
      !Number.isInteger(message.cols) ||
      !Number.isInteger(message.rows)
    ) {
      client.send({ type: 'error', message: 'invalid_resize' });
      return;
    }
    // Dimension policy (floor/ceiling) lives in `lifecycle.resize` via
    // `normalizeResizeDims` — shared with the desktop path so an identical
    // resize behaves identically regardless of transport. The Number.isInteger
    // check above stays: it is wire-shape validation (the client contract
    // depends on the `invalid_resize` reply for malformed input), distinct
    // from dimension policy. Forward the raw integers.
    resizePtySession(message.sid, message.cols as number, message.rows as number);
    return;
  }

  client.send({ type: 'error', message: 'unknown_type' });
}
