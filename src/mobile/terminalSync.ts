import type {
  PtyDataMessage,
  SessionSnapshotMessage,
  TerminalGeometry,
} from '../shared/mobileRemote';

export const MAX_BUFFERED_TERMINAL_CHUNKS = 256;

export type TerminalSyncPhase = 'idle' | 'syncing' | 'live';

export type TerminalSyncRecoveryReason =
  | 'initial'
  | 'sequence-gap'
  | 'future-geometry'
  | 'buffer-overflow';

export type TerminalSyncState = {
  sid: string | null;
  phase: TerminalSyncPhase;
  geometry: TerminalGeometry | null;
  lastSeq: number;
  buffered: Map<number, PtyDataMessage>;
  snapshotRequested: boolean;
  recoveryReason: TerminalSyncRecoveryReason | null;
};

export type TerminalSyncEffect =
  | {
      type: 'installSnapshot';
      sid: string;
      seq: number;
      snapshot: string;
      geometry: TerminalGeometry;
    }
  | { type: 'write'; sid: string; seq: number; data: string }
  | { type: 'requestSnapshot'; sid: string; reason: TerminalSyncRecoveryReason };

export type TerminalSyncResult = {
  state: TerminalSyncState;
  effects: TerminalSyncEffect[];
};

export function emptyTerminalSync(): TerminalSyncState {
  return {
    sid: null,
    phase: 'idle',
    geometry: null,
    lastSeq: -1,
    buffered: new Map(),
    snapshotRequested: false,
    recoveryReason: null,
  };
}

export function beginTerminalSync(sid: string): TerminalSyncState {
  return {
    sid,
    phase: 'syncing',
    geometry: null,
    lastSeq: -1,
    buffered: new Map(),
    snapshotRequested: true,
    recoveryReason: 'initial',
  };
}

function unchanged(state: TerminalSyncState): TerminalSyncResult {
  return { state, effects: [] };
}

function requestRecovery(
  state: TerminalSyncState,
  reason: TerminalSyncRecoveryReason,
): TerminalSyncResult {
  if (!state.sid || state.snapshotRequested) {
    return {
      state: { ...state, phase: 'syncing', recoveryReason: reason },
      effects: [],
    };
  }
  return {
    state: {
      ...state,
      phase: 'syncing',
      snapshotRequested: true,
      recoveryReason: reason,
    },
    effects: [{ type: 'requestSnapshot', sid: state.sid, reason }],
  };
}

function bufferWhileSyncing(
  state: TerminalSyncState,
  message: PtyDataMessage,
  reason: TerminalSyncRecoveryReason,
): TerminalSyncResult {
  if (state.buffered.has(message.seq)) return unchanged(state);
  if (state.buffered.size >= MAX_BUFFERED_TERMINAL_CHUNKS) {
    return requestRecovery({ ...state, buffered: new Map() }, 'buffer-overflow');
  }
  const buffered = new Map(state.buffered);
  buffered.set(message.seq, message);
  return requestRecovery({ ...state, buffered }, reason);
}

function isValidSequence(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isValidGeometry(geometry: TerminalGeometry): boolean {
  return (
    Number.isSafeInteger(geometry.cols) &&
    geometry.cols > 0 &&
    Number.isSafeInteger(geometry.rows) &&
    geometry.rows > 0 &&
    Number.isSafeInteger(geometry.epoch) &&
    geometry.epoch >= 0
  );
}

export function applyTerminalChunk(
  state: TerminalSyncState,
  message: PtyDataMessage,
): TerminalSyncResult {
  if (
    !state.sid ||
    message.sid !== state.sid ||
    !isValidSequence(message.seq) ||
    !isValidSequence(message.geometryEpoch) ||
    message.seq <= state.lastSeq
  ) {
    return unchanged(state);
  }
  if (state.buffered.has(message.seq)) return unchanged(state);
  if (!state.geometry) return bufferWhileSyncing(state, message, 'initial');
  if (message.geometryEpoch < state.geometry.epoch) return unchanged(state);
  if (message.geometryEpoch > state.geometry.epoch) {
    return bufferWhileSyncing(state, message, 'future-geometry');
  }
  if (state.phase === 'live' && message.seq === state.lastSeq + 1) {
    return {
      state: { ...state, lastSeq: message.seq },
      effects: [
        {
          type: 'write',
          sid: message.sid,
          seq: message.seq,
          data: message.chunk,
        },
      ],
    };
  }
  return bufferWhileSyncing(state, message, 'sequence-gap');
}

export function applyTerminalSnapshot(
  state: TerminalSyncState,
  message: SessionSnapshotMessage,
): TerminalSyncResult {
  if (
    !state.sid ||
    message.sid !== state.sid ||
    !isValidSequence(message.seq) ||
    !isValidGeometry(message.geometry)
  ) {
    return unchanged(state);
  }

  const currentEpoch = state.geometry?.epoch;
  if (
    currentEpoch !== undefined &&
    (message.geometry.epoch < currentEpoch ||
      (message.geometry.epoch === currentEpoch && message.seq <= state.lastSeq))
  ) {
    return unchanged(state);
  }

  const buffered = new Map<number, PtyDataMessage>();
  for (const [seq, publication] of state.buffered) {
    if (seq > message.seq && publication.geometryEpoch === message.geometry.epoch) {
      buffered.set(seq, publication);
    }
  }

  const effects: TerminalSyncEffect[] = [
    {
      type: 'installSnapshot',
      sid: message.sid,
      seq: message.seq,
      snapshot: message.snapshot,
      geometry: message.geometry,
    },
  ];
  let lastSeq = message.seq;
  while (buffered.has(lastSeq + 1)) {
    const seq = lastSeq + 1;
    const publication = buffered.get(seq)!;
    buffered.delete(seq);
    effects.push({
      type: 'write',
      sid: publication.sid,
      seq,
      data: publication.chunk,
    });
    lastSeq = seq;
  }

  const installed: TerminalSyncState = {
    ...state,
    phase: 'live',
    geometry: message.geometry,
    lastSeq,
    buffered,
    snapshotRequested: false,
    recoveryReason: null,
  };
  if (buffered.size === 0) return { state: installed, effects };

  const recovery = requestRecovery(installed, 'sequence-gap');
  return {
    state: recovery.state,
    effects: [...effects, ...recovery.effects],
  };
}
