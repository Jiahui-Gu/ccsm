import { onTerminalSyncPublication } from '../ptyHost';
import type { RemotePeer } from './remotePeer';

export function installPtyFanout(peers: ReadonlySet<RemotePeer>): () => void {
  return onTerminalSyncPublication((publication) => {
    for (const peer of peers) {
      if (peer.subscribedSid !== publication.sid) continue;
      if (publication.type === 'chunk') {
        peer.send({
          type: 'pty.data',
          sid: publication.sid,
          chunk: publication.chunk,
          seq: publication.seq,
          geometryEpoch: publication.geometryEpoch,
        });
      } else {
        peer.send({
          type: 'session.snapshot',
          sid: publication.sid,
          seq: publication.seq,
          snapshot: publication.snapshot,
          geometry: publication.geometry,
        });
      }
    }
  });
}
