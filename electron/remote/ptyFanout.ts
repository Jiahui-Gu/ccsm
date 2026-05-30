import type { PeerClient } from './peerClient';

/** Forward one session's terminal bytes to every connected client viewing that
 *  session. The `subscribedSid` gate is the cross-session-leak guard: without
 *  it every client receives every session's raw output. `seq` is ptyHost's
 *  authoritative per-session chunk counter, forwarded verbatim so the client
 *  can dedupe live chunks already baked into a snapshot. Transport-agnostic:
 *  works for WS and DataChannel clients alike (detail spec §6). */
export function fanoutPtyData(
  clients: Iterable<PeerClient>,
  sid: string,
  chunk: string,
  seq: number,
): void {
  for (const client of clients) {
    if (client.subscribedSid !== sid) continue;
    client.send({ type: 'pty.data', sid, chunk, seq });
  }
}
