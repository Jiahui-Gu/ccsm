import { describe, expect, it, expectTypeOf } from 'vitest';
import {
  MIGRATION_EVENT_NAMES,
  MIGRATION_FAILURE_REASONS,
  isMigrationCompleted,
  isMigrationFailed,
  isMigrationStarted,
  type MigrationCompletedEvent,
  type MigrationEvent,
  type MigrationEventName,
  type MigrationFailedEvent,
  type MigrationFailureReason,
  type MigrationStartedEvent,
} from '../migration-events.js';

// T30 contract tests — type-level + runtime narrowing only. No schema
// runtime validator (frag-8 §8.6: closed in-process contract; envelope
// validation is T12's job at the IPC boundary).

describe('MIGRATION_EVENT_NAMES', () => {
  it('exposes exactly the three event names locked by frag-8 §8.6', () => {
    expect(Object.values(MIGRATION_EVENT_NAMES).sort()).toEqual([
      'migration.completed',
      'migration.failed',
      'migration.started',
    ]);
  });

  it('has no progress event (manager r9 lock removed it)', () => {
    expect(Object.values(MIGRATION_EVENT_NAMES)).not.toContain('migration.progress');
  });

  it('union type MigrationEventName matches the constants', () => {
    expectTypeOf<MigrationEventName>().toEqualTypeOf<
      'migration.started' | 'migration.completed' | 'migration.failed'
    >();
  });
});

describe('MIGRATION_FAILURE_REASONS', () => {
  it('contains every reason classified by §8.4–§8.6 emit sites', () => {
    for (const r of [
      'invalid_legacy_path',
      'copy_failed',
      'corrupt_legacy',
      'finalize_failed',
      'disk_full',
      'permission_denied',
      'user_skipped_after_disk_full',
      'corrupt_skipped',
    ] as const) {
      expect(MIGRATION_FAILURE_REASONS).toContain(r);
    }
  });

  it('reason union narrows from the readonly tuple', () => {
    const r: MigrationFailureReason = 'corrupt_legacy';
    expect(MIGRATION_FAILURE_REASONS).toContain(r);
  });
});

describe('discriminated union narrowing', () => {
  const started: MigrationStartedEvent = {
    event: MIGRATION_EVENT_NAMES.started,
    traceId: 't-1',
    // Legacy v0.2 path fixture (uppercase `CCSM`) — frag-8 §8.1; the migration
    // pipeline reads from this shape and writes to the v0.3 lowercase root.
    // eslint-disable-next-line ccsm-local/no-uppercase-ccsm-path
    sourcePath: 'C:/Users/u/AppData/Roaming/CCSM/ccsm.db',
    fromVersion: 1,
    toVersion: 3,
    startedAt: 1_700_000_000_000,
  };
  const completed: MigrationCompletedEvent = {
    event: MIGRATION_EVENT_NAMES.completed,
    traceId: 't-1',
    fromVersion: 1,
    toVersion: 3,
    durationMs: 1234,
    rowsConverted: 42,
  };
  const failed: MigrationFailedEvent = {
    event: MIGRATION_EVENT_NAMES.failed,
    traceId: 't-1',
    fromVersion: 1,
    toVersion: 3,
    reason: 'corrupt_legacy',
    errorMessage: 'database disk image is malformed',
    errorCode: 'SQLITE_CORRUPT',
  };

  it('switch on .event narrows each branch to its concrete type', () => {
    function describeEvent(e: MigrationEvent): string {
      switch (e.event) {
        case MIGRATION_EVENT_NAMES.started:
          // Inside this branch the type is MigrationStartedEvent — sourcePath is required.
          expectTypeOf(e).toEqualTypeOf<MigrationStartedEvent>();
          return `started:${e.sourcePath}`;
        case MIGRATION_EVENT_NAMES.completed:
          expectTypeOf(e).toEqualTypeOf<MigrationCompletedEvent>();
          return `completed:${e.rowsConverted}`;
        case MIGRATION_EVENT_NAMES.failed:
          expectTypeOf(e).toEqualTypeOf<MigrationFailedEvent>();
          return `failed:${e.reason}`;
      }
    }

    expect(describeEvent(started)).toBe(
      // eslint-disable-next-line ccsm-local/no-uppercase-ccsm-path
      'started:C:/Users/u/AppData/Roaming/CCSM/ccsm.db',
    );
    expect(describeEvent(completed)).toBe('completed:42');
    expect(describeEvent(failed)).toBe('failed:corrupt_legacy');
  });

  it('type guards narrow the union', () => {
    const events: MigrationEvent[] = [started, completed, failed];

    const startedFiltered = events.filter(isMigrationStarted);
    expect(startedFiltered).toHaveLength(1);
    expect(startedFiltered[0]?.sourcePath).toBe(started.sourcePath);

    const completedFiltered = events.filter(isMigrationCompleted);
    expect(completedFiltered).toHaveLength(1);
    expect(completedFiltered[0]?.rowsConverted).toBe(42);

    const failedFiltered = events.filter(isMigrationFailed);
    expect(failedFiltered).toHaveLength(1);
    expect(failedFiltered[0]?.reason).toBe('corrupt_legacy');
  });

  it('failed event leaves errorCode optional', () => {
    const minimal: MigrationFailedEvent = {
      event: MIGRATION_EVENT_NAMES.failed,
      traceId: 't-2',
      fromVersion: 1,
      toVersion: 3,
      reason: 'invalid_legacy_path',
      errorMessage: 'realpath outside allowlist',
    };
    expect(minimal.errorCode).toBeUndefined();
    expect(isMigrationFailed(minimal)).toBe(true);
  });
});

describe('event names round-trip with the schema constants', () => {
  it('every event in the union carries one of the canonical names', () => {
    const all: MigrationEvent[] = [
      {
        event: MIGRATION_EVENT_NAMES.started,
        traceId: 'x',
        sourcePath: '/x',
        fromVersion: 1,
        toVersion: 3,
        startedAt: 0,
      },
      {
        event: MIGRATION_EVENT_NAMES.completed,
        traceId: 'x',
        fromVersion: 1,
        toVersion: 3,
        durationMs: 0,
        rowsConverted: 0,
      },
      {
        event: MIGRATION_EVENT_NAMES.failed,
        traceId: 'x',
        fromVersion: 1,
        toVersion: 3,
        reason: 'finalize_failed',
        errorMessage: 'rename EBUSY',
        errorCode: 'EBUSY',
      },
    ];
    for (const e of all) {
      expect(Object.values(MIGRATION_EVENT_NAMES)).toContain(e.event);
    }
  });
});
