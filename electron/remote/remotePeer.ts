import type { MobileServerMessage } from './remoteMessages';

export interface RemotePeer {
  subscribedSid: string | null;
  send(payload: MobileServerMessage): void;
}
