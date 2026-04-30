import { describe, it, expect } from 'vitest';
import { checkMigrationGate } from '../migration-gate-interceptor.js';
import { SUPERVISOR_RPCS } from '../supervisor-rpcs.js';

describe('checkMigrationGate (spec §3.4.1.f)', () => {
  describe('migrationPending = false (fast path)', () => {
    it.each([...SUPERVISOR_RPCS])(
      'allows supervisor RPC %s when no migration is pending',
      (rpcName) => {
        expect(checkMigrationGate({ rpcName, migrationPending: false })).toEqual({
          allowed: true,
        });
      },
    );

    it.each([
      'ccsm.v1/session.subscribe',
      'ccsm.v1/session.send',
      'ccsm.v1/pty.write',
      'daemon.foo',
      '',
    ])('allows data-plane RPC %j when no migration is pending', (rpcName) => {
      expect(checkMigrationGate({ rpcName, migrationPending: false })).toEqual({
        allowed: true,
      });
    });
  });

  describe('migrationPending = true (gate engaged)', () => {
    it.each([...SUPERVISOR_RPCS])(
      'allows supervisor RPC %s during migration (carve-out)',
      (rpcName) => {
        expect(checkMigrationGate({ rpcName, migrationPending: true })).toEqual({
          allowed: true,
        });
      },
    );

    it.each([
      'ccsm.v1/session.subscribe',
      'ccsm.v1/session.send',
      'ccsm.v1/pty.write',
      'ccsm.v1/daemon.stats',
      'daemon.shutdownForUpgradeNow',
      'daemon.HELLO',
      ' daemon.hello',
      'daemon.hello ',
      '/healthz/extra',
      '/stat',
      '',
    ])('blocks non-supervisor RPC %j during migration', (rpcName) => {
      const decision = checkMigrationGate({ rpcName, migrationPending: true });
      expect(decision.allowed).toBe(false);
      if (decision.allowed === false) {
        expect(decision.error.code).toBe('MIGRATION_PENDING');
        expect(decision.error.message).toContain(rpcName);
      }
    });

    it('error message identifies the rejected rpcName for debug', () => {
      const decision = checkMigrationGate({
        rpcName: 'ccsm.v1/session.subscribe',
        migrationPending: true,
      });
      expect(decision).toEqual({
        allowed: false,
        error: {
          code: 'MIGRATION_PENDING',
          message: expect.stringContaining('ccsm.v1/session.subscribe'),
        },
      });
    });
  });

  describe('purity / no normalisation', () => {
    it('does not prefix-match supervisor names during migration', () => {
      // `daemon.shutdownForUpgradeNow` shares a prefix with the canonical
      // `daemon.shutdownForUpgrade`, but literal-compare per §3.4.1.h means
      // it must be blocked.
      expect(
        checkMigrationGate({
          rpcName: 'daemon.shutdownForUpgradeNow',
          migrationPending: true,
        }),
      ).toMatchObject({ allowed: false, error: { code: 'MIGRATION_PENDING' } });
    });

    it('treats whitespace-padded supervisor names as data-plane', () => {
      expect(
        checkMigrationGate({
          rpcName: ' daemon.hello',
          migrationPending: true,
        }),
      ).toMatchObject({ allowed: false, error: { code: 'MIGRATION_PENDING' } });
    });
  });
});
