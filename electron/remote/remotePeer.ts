import type { MirrorServerMessage } from '../../src/shared/mobileRemote';
import type { MobileServerMessage } from './remoteMessages';

export interface RemotePeer {
  subscribedSid: string | null;
  send(payload: MobileServerMessage | MirrorServerMessage): void;
}
