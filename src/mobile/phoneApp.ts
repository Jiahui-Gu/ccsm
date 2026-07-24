import {
  applyTerminalChunk,
  applyTerminalSnapshot,
  beginTerminalSync,
  emptyTerminalSync,
  type TerminalSyncEffect,
  type TerminalSyncState,
} from './terminalSync';

import type {
  MobileClientMessage,
  MobileServerMessage,
  SessionListEntry,
} from '../shared/mobileRemote';
import type { SessionNavigatorModel } from '../shared/sessionNavigator';

export type { MobileClientMessage, MobileServerMessage, SessionListEntry } from '../shared/mobileRemote';
export type { TerminalSyncEffect } from './terminalSync';

export type PhoneState = {
  sessions: SessionListEntry[];
  navigator: SessionNavigatorModel | null;
  activeSid: string;
  terminalSync: TerminalSyncState;
};

// A single reducer step: the next state, the terminal effects (reset/write/
// requestSnapshot) that must be applied to the read-only xterm display, and
// any client commands (e.g. a `session.snapshot` request) that must be sent
// back over the relay as a result.
export type PhoneTransition = {
  state: PhoneState;
  terminalEffects: TerminalSyncEffect[];
  commands: MobileClientMessage[];
};

export function emptyPhoneState(): PhoneState {
  return {
    sessions: [],
    navigator: null,
    activeSid: '',
    terminalSync: emptyTerminalSync(),
  };
}

function noopTransition(state: PhoneState): PhoneTransition {
  return { state, terminalEffects: [], commands: [] };
}

// Any `requestSnapshot` terminal effect must also become an outgoing
// `session.snapshot` client command so the desktop actually resends the
// authoritative screen; a gap must never be papered over locally.
function commandsForEffects(effects: TerminalSyncEffect[]): MobileClientMessage[] {
  const commands: MobileClientMessage[] = [];
  for (const effect of effects) {
    if (effect.type === 'requestSnapshot') {
      commands.push({ type: 'session.snapshot', sid: effect.sid });
    }
  }
  return commands;
}

function withTerminalSyncResult(
  state: PhoneState,
  result: { state: TerminalSyncState; effects: TerminalSyncEffect[] },
): PhoneTransition {
  return {
    state: { ...state, terminalSync: result.state },
    terminalEffects: result.effects,
    commands: commandsForEffects(result.effects),
  };
}

export function applyServerMessage(state: PhoneState, message: MobileServerMessage): PhoneTransition {
  if (message.type === 'sessions.list') {
    return noopTransition({ ...state, sessions: message.sessions });
  }
  if (message.type === 'sessions.navigator') {
    return noopTransition({ ...state, navigator: message.model });
  }
  if (message.type === 'session.snapshot') {
    return withTerminalSyncResult(state, applyTerminalSnapshot(state.terminalSync, message));
  }
  if (message.type === 'pty.data') {
    return withTerminalSyncResult(state, applyTerminalChunk(state.terminalSync, message));
  }
  return noopTransition(state);
}

export function selectSession(state: PhoneState, sid: string): PhoneTransition {
  return {
    state: {
      ...state,
      activeSid: sid,
      terminalSync: beginTerminalSync(sid),
    },
    terminalEffects: [],
    commands: [{ type: 'session.snapshot', sid }],
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
