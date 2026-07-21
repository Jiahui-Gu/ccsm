// Pure exactly-once snapshot/live synchronization state machine for the
// mobile remote terminal. Converts server `session.snapshot` and `pty.data`
// messages into deterministic terminal effects (reset/write) plus at most
// one outstanding `requestSnapshot` while a gap is being resolved.

export const MAX_BUFFERED_TERMINAL_CHUNKS = 256;

export type TerminalSyncPhase = 'idle' | 'syncing' | 'live';

export type TerminalSyncState = {
  sid: string | null;
  phase: TerminalSyncPhase;
  lastSeq: number;
  snapshotRequested: boolean;
  buffered: ReadonlyMap<number, string>;
};

export type TerminalSyncEffect =
  | { type: 'reset'; data: string }
  | { type: 'write'; data: string }
  | { type: 'requestSnapshot'; sid: string };

export type TerminalSyncResult = {
  state: TerminalSyncState;
  effects: TerminalSyncEffect[];
};

export type TerminalChunkMessage = {
  sid: string;
  seq: number;
  chunk: string;
};

export type TerminalSnapshotMessage = {
  sid: string;
  seq: number;
  data?: string;
  snapshot?: string;
};

export function emptyTerminalSync(): TerminalSyncState {
  return {
    sid: null,
    phase: 'idle',
    lastSeq: -1,
    snapshotRequested: false,
    buffered: new Map(),
  };
}

// Starting sync for a (possibly new) session id. The caller is responsible
// for issuing exactly one `session.snapshot` request alongside this call, so
// `snapshotRequested` starts true to prevent a redundant request being
// synthesized for out-of-order chunks that race ahead of that snapshot.
export function beginTerminalSync(sid: string): TerminalSyncState {
  return {
    sid,
    phase: 'syncing',
    lastSeq: -1,
    snapshotRequested: true,
    buffered: new Map(),
  };
}

// Inserts a chunk into the buffer unless its sequence is already present
// (first received authoritative bytes win — never overwritten and never
// counted twice). Bounds the buffer to MAX_BUFFERED_TERMINAL_CHUNKS by
// deterministically evicting the highest (far-future) sequence, preserving
// the lowest/nearest-to-lastSeq tail needed to close gaps.
function boundedInsert(
  buffered: ReadonlyMap<number, string>,
  seq: number,
  chunk: string,
): ReadonlyMap<number, string> {
  if (buffered.has(seq)) return buffered;
  const next = new Map(buffered);
  next.set(seq, chunk);
  if (next.size > MAX_BUFFERED_TERMINAL_CHUNKS) {
    let highestSeq = seq;
    for (const key of next.keys()) {
      if (key > highestSeq) highestSeq = key;
    }
    next.delete(highestSeq);
  }
  return next;
}

export function applyTerminalChunk(
  state: TerminalSyncState,
  message: TerminalChunkMessage,
): TerminalSyncResult {
  if (
    message.sid !== state.sid ||
    !Number.isInteger(message.seq) ||
    message.seq <= state.lastSeq
  ) {
    return { state, effects: [] };
  }

  if (state.phase === 'live' && message.seq === state.lastSeq + 1) {
    return {
      state: { ...state, lastSeq: message.seq },
      effects: [{ type: 'write', data: message.chunk }],
    };
  }

  const buffered = boundedInsert(state.buffered, message.seq, message.chunk);
  const effects: TerminalSyncEffect[] =
    !state.snapshotRequested && state.sid !== null
      ? [{ type: 'requestSnapshot', sid: state.sid }]
      : [];
  return {
    state: { ...state, phase: 'syncing', buffered, snapshotRequested: true },
    effects,
  };
}

export function applyTerminalSnapshot(
  state: TerminalSyncState,
  message: TerminalSnapshotMessage,
): TerminalSyncResult {
  if (
    message.sid !== state.sid ||
    !Number.isInteger(message.seq) ||
    message.seq <= state.lastSeq
  ) {
    return { state, effects: [] };
  }

  const data = message.data ?? message.snapshot ?? '';
  const effects: TerminalSyncEffect[] = [{ type: 'reset', data }];

  const remaining = new Map(state.buffered);
  for (const key of remaining.keys()) {
    if (key <= message.seq) remaining.delete(key);
  }

  let lastSeq = message.seq;
  while (remaining.has(lastSeq + 1)) {
    const next = lastSeq + 1;
    effects.push({ type: 'write', data: remaining.get(next)! });
    remaining.delete(next);
    lastSeq = next;
  }

  const hasGap = remaining.size > 0;
  if (hasGap && state.sid !== null) {
    effects.push({ type: 'requestSnapshot', sid: state.sid });
  }

  return {
    state: {
      ...state,
      lastSeq,
      buffered: remaining,
      phase: hasGap ? 'syncing' : 'live',
      snapshotRequested: hasGap,
    },
    effects,
  };
}
