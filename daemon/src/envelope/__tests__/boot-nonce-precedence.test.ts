import { describe, expect, it } from 'vitest';

import {
  BOOT_NONCE_HEADER,
  applyBootNoncePrecedence,
} from '../boot-nonce-precedence.js';

describe('boot-nonce-precedence: applyBootNoncePrecedence()', () => {
  it('daemon nonce overrides client nonce (anti-spoof)', () => {
    const result = applyBootNoncePrecedence(
      { [BOOT_NONCE_HEADER]: 'daemon-ULID-AAA' },
      { [BOOT_NONCE_HEADER]: 'client-tried-BBB' },
    );
    expect(result[BOOT_NONCE_HEADER]).toBe('daemon-ULID-AAA');
  });

  it('client nonce kept when daemon does not set one', () => {
    const result = applyBootNoncePrecedence(
      {},
      { [BOOT_NONCE_HEADER]: 'client-known-CCC' },
    );
    expect(result[BOOT_NONCE_HEADER]).toBe('client-known-CCC');
  });

  it('daemon nonce passes through when client absent', () => {
    const result = applyBootNoncePrecedence(
      { [BOOT_NONCE_HEADER]: 'daemon-ULID-DDD' },
      {},
    );
    expect(result[BOOT_NONCE_HEADER]).toBe('daemon-ULID-DDD');
  });

  it('omits the boot-nonce key when neither side sets it', () => {
    const result = applyBootNoncePrecedence({}, {});
    expect(BOOT_NONCE_HEADER in result).toBe(false);
  });

  it('handles null/undefined inputs without throwing', () => {
    expect(applyBootNoncePrecedence(null, null)).toEqual({});
    expect(applyBootNoncePrecedence(undefined, undefined)).toEqual({});
    expect(applyBootNoncePrecedence(null, { [BOOT_NONCE_HEADER]: 'x' })).toEqual({
      [BOOT_NONCE_HEADER]: 'x',
    });
    expect(applyBootNoncePrecedence({ [BOOT_NONCE_HEADER]: 'y' }, null)).toEqual({
      [BOOT_NONCE_HEADER]: 'y',
    });
  });

  it('preserves other headers from both sides (last-writer-wins for non-reserved)', () => {
    const result = applyBootNoncePrecedence(
      { 'x-ccsm-deadline-ms': '5000', [BOOT_NONCE_HEADER]: 'D' },
      { 'x-ccsm-trace-id': '01HXXXXXXXXXXXXXXXXXXXXXXX', 'x-ccsm-deadline-ms': '120000' },
    );
    expect(result['x-ccsm-trace-id']).toBe('01HXXXXXXXXXXXXXXXXXXXXXXX');
    // daemon overrides client deadline (general last-writer rule).
    expect(result['x-ccsm-deadline-ms']).toBe('5000');
    expect(result[BOOT_NONCE_HEADER]).toBe('D');
  });

  it('does not mutate the daemon header input', () => {
    const daemon = Object.freeze({ [BOOT_NONCE_HEADER]: 'D', other: '1' });
    const client = { [BOOT_NONCE_HEADER]: 'C', extra: '2' };
    const before = { ...daemon };
    applyBootNoncePrecedence(daemon, client);
    expect({ ...daemon }).toEqual(before);
  });

  it('does not mutate the client header input', () => {
    const daemon = { [BOOT_NONCE_HEADER]: 'D' };
    const client = Object.freeze({ [BOOT_NONCE_HEADER]: 'C', kept: 'yes' });
    const snapshot = { ...client };
    const result = applyBootNoncePrecedence(daemon, client);
    expect({ ...client }).toEqual(snapshot);
    expect(result.kept).toBe('yes');
  });

  it('returns a fresh object each call (no shared reference)', () => {
    const daemon = { [BOOT_NONCE_HEADER]: 'D' };
    const client = { other: 'x' };
    const a = applyBootNoncePrecedence(daemon, client);
    const b = applyBootNoncePrecedence(daemon, client);
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  it('daemon overrides client even when daemon value is empty string (explicit assertion)', () => {
    // If daemon explicitly asserts an empty boot nonce, that still wins —
    // an empty string is a meaningful daemon-asserted value, not absence.
    const result = applyBootNoncePrecedence(
      { [BOOT_NONCE_HEADER]: '' },
      { [BOOT_NONCE_HEADER]: 'client-spoof' },
    );
    expect(result[BOOT_NONCE_HEADER]).toBe('');
  });
});
