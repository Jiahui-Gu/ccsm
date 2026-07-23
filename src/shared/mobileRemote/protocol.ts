import {
  SESSION_NAVIGATOR_MESSAGE_VERSION,
  type SessionNavigatorModel,
} from '../sessionNavigator';

export const MOBILE_REMOTE_PROTOCOL_VERSION = 1 as const;

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

export type SessionListEntry = {
  sid: string;
  cwd: string;
  cols: number;
  rows: number;
};

// Mobile composer complete-draft submission (Task 1). 64 KiB character
// ceiling — generous for any pasted/typed draft, but bounded so a
// malformed/hostile client can't force an unbounded PTY write.
export const MAX_MOBILE_SUBMIT_CHARS = 65_536;

export type MobileClientMessage =
  | { type: 'sessions.list' }
  | { type: 'session.snapshot'; sid: string }
  | { type: 'session.input'; sid: string; data: string }
  | { type: 'session.submit'; sid: string; requestId: string; draft: string }
  // Legacy compatibility only. Desktop accepts and ignores this message so
  // older phone clients cannot take ownership of the shared PTY dimensions.
  | { type: 'session.resize'; sid: string; cols: number; rows: number };

export type SessionSubmitResult = {
  type: 'session.submit.result';
  sid: string;
  requestId: string;
  ok: boolean;
  error?: 'invalid_submission' | 'session_not_found' | 'pty_write_failed';
};

export type SessionSnapshotMessage = {
  type: 'session.snapshot';
  sid: string;
  seq: number;
  data?: string;
  snapshot?: string;
  cols: number | null;
  rows: number | null;
};

export type MobileServerMessage =
  | { type: 'sessions.list'; sessions: SessionListEntry[] }
  | {
      type: 'sessions.navigator';
      version: typeof SESSION_NAVIGATOR_MESSAGE_VERSION;
      model: SessionNavigatorModel;
    }
  | SessionSnapshotMessage
  | { type: 'pty.data'; sid: string; seq: number; chunk: string }
  | SessionSubmitResult
  | { type: 'error'; message: string };
