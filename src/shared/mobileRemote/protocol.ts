export const MOBILE_REMOTE_PROTOCOL_VERSION = 3 as const;

export type RelayRole = 'desktop' | 'phone';

export type PairingIdentity = {
  roomId: string;
  secret: string;
};

export type HandshakeHello = {
  type: 'handshake.hello';
  version: typeof MOBILE_REMOTE_PROTOCOL_VERSION;
  role: RelayRole;
  connectionId: string;
  nonce: string;
};

export type HandshakeProof = {
  type: 'handshake.proof';
  connectionId: string;
  proof: string;
};

export type EncryptedEnvelope = {
  type: 'encrypted';
  version: typeof MOBILE_REMOTE_PROTOCOL_VERSION;
  connectionId: string;
  sequence: number;
  ciphertext: string;
};
