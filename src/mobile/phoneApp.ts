export type SessionListEntry = {
  sid: string;
  cwd: string;
  cols: number;
  rows: number;
};

export type MobileClientMessage =
  | { type: 'sessions.list' }
  | { type: 'session.snapshot'; sid: string }
  | { type: 'session.input'; sid: string; data: string }
  | { type: 'session.resize'; sid: string; cols: number; rows: number };

export type MobileServerMessage =
  | { type: 'sessions.list'; sessions: SessionListEntry[] }
  | {
      type: 'session.snapshot';
      sid: string;
      seq: number;
      data?: string;
      snapshot?: string;
      cols: number | null;
      rows: number | null;
    }
  | { type: 'pty.data'; sid: string; seq: number; chunk: string }
  | { type: 'error'; message: string };

export type PhoneState = {
  sessions: SessionListEntry[];
  activeSid: string;
  snapshotSequence: number;
  terminalReset: boolean;
  terminalWrites: string[];
};

export function emptyPhoneState(): PhoneState {
  return {
    sessions: [],
    activeSid: '',
    snapshotSequence: -1,
    terminalReset: false,
    terminalWrites: [],
  };
}

export function applySnapshot(
  state: PhoneState,
  snapshot: { sid: string; seq: number; data?: string; snapshot?: string },
): PhoneState {
  if (snapshot.sid !== state.activeSid && state.activeSid !== '') return state;
  return {
    ...state,
    activeSid: snapshot.sid,
    snapshotSequence: Number.isInteger(snapshot.seq) ? snapshot.seq : -1,
    terminalReset: true,
    terminalWrites: [snapshot.data ?? snapshot.snapshot ?? ''],
  };
}

export function applyPtyData(
  state: PhoneState,
  message: { sid: string; seq: number; chunk: string },
): PhoneState {
  if (
    message.sid !== state.activeSid ||
    (Number.isInteger(message.seq) && message.seq <= state.snapshotSequence)
  ) {
    return state;
  }
  return {
    ...state,
    snapshotSequence: Number.isInteger(message.seq) ? message.seq : state.snapshotSequence,
    terminalReset: false,
    terminalWrites: [message.chunk],
  };
}

export function applyServerMessage(state: PhoneState, message: MobileServerMessage): PhoneState {
  if (message.type === 'sessions.list') {
    return {
      ...state,
      sessions: message.sessions,
      terminalReset: false,
      terminalWrites: [],
    };
  }
  if (message.type === 'session.snapshot') return applySnapshot(state, message);
  if (message.type === 'pty.data') return applyPtyData(state, message);
  return state;
}

export function selectSession(
  state: PhoneState,
  sid: string,
): { state: PhoneState; message: MobileClientMessage } {
  return {
    state: {
      ...state,
      activeSid: sid,
      snapshotSequence: -1,
      terminalReset: true,
      terminalWrites: [],
    },
    message: { type: 'session.snapshot', sid },
  };
}

export function controlInput(
  data: string,
  ctrlSticky: boolean,
): { data: string; ctrlSticky: boolean } {
  if (!ctrlSticky || data.length === 0) return { data, ctrlSticky };
  const code = data.charCodeAt(0);
  if (code >= 97 && code <= 122) return { data: String.fromCharCode(code - 96), ctrlSticky: false };
  if (code >= 65 && code <= 90) return { data: String.fromCharCode(code - 64), ctrlSticky: false };
  return { data, ctrlSticky: false };
}
