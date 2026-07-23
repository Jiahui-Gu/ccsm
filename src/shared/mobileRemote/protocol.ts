import {
  SESSION_NAVIGATOR_MESSAGE_VERSION,
  type SessionNavigatorModel,
} from '../sessionNavigator';

export const MOBILE_REMOTE_PROTOCOL_VERSION = 2 as const;
export const MAX_TERMINAL_DIMENSION = 1000;

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

export type TerminalGeometry = {
  cols: number;
  rows: number;
  epoch: number;
};

export type SessionListEntry = {
  sid: string;
  cwd: string;
  geometry?: TerminalGeometry;
  cols?: number;
  rows?: number;
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
  snapshot?: string;
  data?: string;
  geometry?: TerminalGeometry;
  cols?: number | null;
  rows?: number | null;
};

export type PtyDataMessage = {
  type: 'pty.data';
  sid: string;
  seq: number;
  chunk: string;
  geometryEpoch?: number;
};

export type MobileServerMessage =
  | { type: 'sessions.list'; sessions: SessionListEntry[] }
  | {
      type: 'sessions.navigator';
      version: typeof SESSION_NAVIGATOR_MESSAGE_VERSION;
      model: SessionNavigatorModel;
    }
  | SessionSnapshotMessage
  | PtyDataMessage
  | SessionSubmitResult
  | { type: 'error'; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isSafeInteger(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isTerminalGeometry(value: unknown): value is TerminalGeometry {
  if (!isRecord(value)) return false;
  return (
    isSafeInteger(value.cols, 1, MAX_TERMINAL_DIMENSION) &&
    isSafeInteger(value.rows, 1, MAX_TERMINAL_DIMENSION) &&
    isSafeInteger(value.epoch, 0, Number.MAX_SAFE_INTEGER)
  );
}

function isSessionListEntry(value: unknown): value is SessionListEntry {
  if (!isRecord(value) || !isNonEmptyString(value.sid) || !isNonEmptyString(value.cwd)) return false;
  return (
    isTerminalGeometry(value.geometry) &&
    value.cols === undefined &&
    value.rows === undefined
  );
}

function isSessionNavigatorModel(value: unknown): value is SessionNavigatorModel {
  if (!isRecord(value)) return false;
  return Array.isArray(value.groups) && (value.activeSessionId === null || typeof value.activeSessionId === 'string');
}

function isSessionSnapshotMessage(value: unknown): value is SessionSnapshotMessage {
  if (!isRecord(value) || value.type !== 'session.snapshot') return false;
  if (!isNonEmptyString(value.sid) || !isSafeInteger(value.seq, 0, Number.MAX_SAFE_INTEGER)) {
    return false;
  }
  return (
    typeof value.snapshot === 'string' &&
    value.data === undefined &&
    isTerminalGeometry(value.geometry) &&
    value.cols === undefined &&
    value.rows === undefined
  );
}

function isPtyDataMessage(value: unknown): value is PtyDataMessage {
  if (!isRecord(value) || value.type !== 'pty.data') return false;
  if (!isNonEmptyString(value.sid) || !isSafeInteger(value.seq, 0, Number.MAX_SAFE_INTEGER)) {
    return false;
  }
  if (typeof value.chunk !== 'string') return false;
  return isSafeInteger(value.geometryEpoch, 0, Number.MAX_SAFE_INTEGER);
}

function isSessionSubmitResult(value: unknown): value is SessionSubmitResult {
  return (
    isRecord(value) &&
    value.type === 'session.submit.result' &&
    isNonEmptyString(value.sid) &&
    isNonEmptyString(value.requestId) &&
    typeof value.ok === 'boolean' &&
    (value.error === undefined ||
      value.error === 'invalid_submission' ||
      value.error === 'session_not_found' ||
      value.error === 'pty_write_failed')
  );
}

function isErrorMessage(value: unknown): value is { type: 'error'; message: string } {
  return isRecord(value) && value.type === 'error' && typeof value.message === 'string';
}

export function isMobileClientMessage(value: unknown): value is MobileClientMessage {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case 'sessions.list':
      return true;
    case 'session.snapshot':
      return isNonEmptyString(value.sid);
    case 'session.input':
      return isNonEmptyString(value.sid) && typeof value.data === 'string';
    case 'session.submit':
      return (
        isNonEmptyString(value.sid) &&
        isNonEmptyString(value.requestId) &&
        typeof value.draft === 'string' &&
        value.draft.length > 0 &&
        value.draft.length <= MAX_MOBILE_SUBMIT_CHARS
      );
    case 'session.resize':
      return false;
    default:
      return false;
  }
}

export function isMobileServerMessage(value: unknown): value is MobileServerMessage {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case 'sessions.list':
      return Array.isArray(value.sessions) && value.sessions.every(isSessionListEntry);
    case 'sessions.navigator':
      return (
        value.version === SESSION_NAVIGATOR_MESSAGE_VERSION &&
        isSessionNavigatorModel(value.model)
      );
    case 'session.snapshot':
      return isSessionSnapshotMessage(value);
    case 'pty.data':
      return isPtyDataMessage(value);
    case 'session.submit.result':
      return isSessionSubmitResult(value);
    case 'error':
      return isErrorMessage(value);
    default:
      return false;
  }
}
