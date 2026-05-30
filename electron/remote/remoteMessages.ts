import {
  getBufferSnapshot,
  getPtySession,
  inputPtySession,
  listPtySessions,
} from '../ptyHost';
import { isRecord } from './remoteHttp';
import type { WsClient } from './wsProtocol';

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
    client.send({ type: 'sessions.list', sessions: listPtySessions() });
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

  client.send({ type: 'error', message: 'unknown_type' });
}
