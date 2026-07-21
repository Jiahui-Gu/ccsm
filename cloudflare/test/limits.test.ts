/* global Request, RequestInit */

import { describe, expect, it } from 'vitest';

import {
  DESKTOP_ABSENT_TIMEOUT_MS,
  HANDSHAKE_TIMEOUT_MS,
  MAX_RELAY_FRAME_BYTES,
} from '../src/limits';
import { parseRelayRequest } from '../src/worker';

const VALID_ROOM_ID = 'A'.repeat(43);

function upgradeRequest(path: string, init?: RequestInit): Request {
  return new Request(`https://relay.example${path}`, {
    headers: { Upgrade: 'websocket', ...init?.headers },
    method: init?.method,
  });
}

describe('relay request limits', () => {
  it('rejects a malformed room id', () => {
    expect(parseRelayRequest(upgradeRequest('/relay/bad?role=desktop'))).toEqual({
      ok: false,
      status: 400,
    });
  });

  it('parses a valid desktop upgrade', () => {
    expect(
      parseRelayRequest(upgradeRequest(`/relay/${VALID_ROOM_ID}?role=desktop`)),
    ).toEqual({
      ok: true,
      value: { roomId: VALID_ROOM_ID, role: 'desktop' },
    });
  });

  it('uses the specified frame and timeout limits', () => {
    expect(MAX_RELAY_FRAME_BYTES).toBe(1_048_576);
    expect(HANDSHAKE_TIMEOUT_MS).toBe(10_000);
    expect(DESKTOP_ABSENT_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
