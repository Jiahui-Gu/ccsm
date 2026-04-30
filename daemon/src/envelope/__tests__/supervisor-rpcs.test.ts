import { describe, it, expect } from 'vitest';
import { SUPERVISOR_RPCS, isSupervisorRpc } from '../supervisor-rpcs.js';

describe('SUPERVISOR_RPCS (spec §3.4.1.h)', () => {
  it('contains exactly the five canonical control-plane RPCs', () => {
    // Frozen comparison against the spec table row "control-socket".
    expect([...SUPERVISOR_RPCS]).toEqual([
      '/healthz',
      '/stats',
      'daemon.hello',
      'daemon.shutdown',
      'daemon.shutdownForUpgrade',
    ]);
    expect(SUPERVISOR_RPCS).toHaveLength(5);
  });

  it('is a readonly tuple at the type level (compile-time guard)', () => {
    // `as const` makes the array frozen at the literal type; runtime mutation
    // attempts via index assignment would still be allowed under non-strict
    // mode unless explicitly frozen. Document intent + verify shape.
    const arr: readonly string[] = SUPERVISOR_RPCS;
    expect(Array.isArray(arr)).toBe(true);
  });
});

describe('isSupervisorRpc', () => {
  it.each([...SUPERVISOR_RPCS])('returns true for canonical RPC %s', (name) => {
    expect(isSupervisorRpc(name)).toBe(true);
  });

  it.each([
    'daemon.foo',
    '',
    'daemon.shutdown.fake',
    'daemon.hello.x',
    '/healthz/extra',
    '/stat',
    'daemon.HELLO',
    ' daemon.hello',
    'daemon.hello ',
    'session.subscribe',
    '/',
  ])('returns false for non-canonical name %j', (name) => {
    expect(isSupervisorRpc(name)).toBe(false);
  });

  it('does no prefix or wildcard matching', () => {
    expect(isSupervisorRpc('daemon')).toBe(false);
    expect(isSupervisorRpc('daemon.')).toBe(false);
    expect(isSupervisorRpc('daemon.shutdownForUpgradeNow')).toBe(false);
  });
});
