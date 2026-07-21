import { describe, expect, it } from 'vitest';

import {
  applyPtyData,
  applyServerMessage,
  applySnapshot,
  controlInput,
  emptyPhoneState,
  type MobileServerMessage,
  selectSession,
} from '../../src/mobile/phoneApp';

describe('phone protocol state', () => {
  it('drops live chunks already covered by a snapshot', () => {
    const state = applySnapshot(emptyPhoneState(), { sid: 's1', seq: 8, data: 'full' });

    expect(applyPtyData(state, { sid: 's1', seq: 8, chunk: 'duplicate' })).toBe(state);
    const live = applyPtyData(state, { sid: 's1', seq: 9, chunk: 'new' });
    expect(live.terminalWrites).toEqual(['new']);
    expect(applyPtyData(live, { sid: 's1', seq: 9, chunk: 'duplicate-live' })).toBe(live);
  });

  it('repaints a selected session from its authoritative snapshot', () => {
    const selected = selectSession(emptyPhoneState(), 's1');
    const repainted = applyServerMessage(selected.state, {
      type: 'session.snapshot',
      sid: 's1',
      seq: 4,
      data: 'screen',
      cols: 80,
      rows: 24,
    });

    expect(selected.message).toEqual({ type: 'session.snapshot', sid: 's1' });
    expect(repainted.terminalReset).toBe(true);
    expect(repainted.terminalWrites).toEqual(['screen']);
  });

  it('applies shared navigator server messages', () => {
    const navigatorMessage: MobileServerMessage = {
      type: 'sessions.navigator',
      version: 1,
      model: { groups: [], activeSessionId: null },
    };

    expect(applyServerMessage(emptyPhoneState(), navigatorMessage).navigator).toEqual(
      navigatorMessage.model,
    );
  });

  it('applies sticky Ctrl once to ASCII letters', () => {
    expect(controlInput('a', true)).toEqual({ data: '\x01', ctrlSticky: false });
    expect(controlInput('Z', true)).toEqual({ data: '\x1a', ctrlSticky: false });
    expect(controlInput('1', true)).toEqual({ data: '1', ctrlSticky: false });
  });
});
