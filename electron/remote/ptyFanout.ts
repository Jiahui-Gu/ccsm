import { getPtySession, onPtyData } from '../ptyHost';
import type { RemotePeer } from './remotePeer';

export function installPtyFanout(peers: ReadonlySet<RemotePeer>): () => void {
  return onPtyData((sid, chunk, seq) => {
    const info = getPtySession(sid);
    if (!info) return;
    for (const peer of peers) {
      if (peer.subscribedSid === sid) {
        peer.send({
          type: 'pty.data',
          sid,
          chunk,
          seq,
          geometryEpoch: info.geometry.epoch,
        });
      }
    }
  });
}
