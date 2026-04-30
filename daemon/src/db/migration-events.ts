// T30: migration event contracts (frag-8 §8.5, §8.6).
//
// SCHEMAS ONLY — this file declares the discriminated union of events
// emitted by the migration runner (T29) and consumed by the in-progress
// modal driver (T33). NO emitter, NO consumer, NO side effects live
// here. Single Responsibility producer/decider/sink: this is the wire
// contract that producer (T29) and sink (T33) both compile against.
//
// Library choice: pure TypeScript discriminated union, no TypeBox / zod.
// Rationale:
//   - Spec frag-8 §8.6 (manager r9 lock) defines exactly THREE events:
//     started, completed, failed. No `progress` event — the in-progress
//     modal is an indeterminate spinner driven by start/complete/failed
//     transitions only. Closed contract surface, not a wire schema that
//     needs runtime validation against untrusted input.
//   - Both producer (T29 daemon) and consumer (T33 renderer) are inside
//     the trust boundary; the IPC adapter (frag-3.4.1, T12) will run
//     TypeBox `Check()` on the *envelope*, so payload structure is
//     already gated upstream once T12 lands.
//   - daemon/package.json carries no schema lib yet; adding TypeBox
//     here would be the first non-test dep and is better introduced
//     systematically in T12 alongside the envelope contracts. This
//     module can migrate to TypeBox without touching call sites by
//     deriving the same types via `Static<typeof Schema>`.
//
// Failure reasons enumerated from frag-8 §8.4–§8.6 emit sites
// (`MigrationFailedEvent({reason: ...})`).

/** Canonical event names, used as the discriminator on `event`. */
export const MIGRATION_EVENT_NAMES = {
  started: 'migration.started',
  completed: 'migration.completed',
  failed: 'migration.failed',
} as const;

export type MigrationEventName =
  (typeof MIGRATION_EVENT_NAMES)[keyof typeof MIGRATION_EVENT_NAMES];

/**
 * Failure reason codes emitted by the migration runner.
 *
 * Source: frag-8 §8.4 (`invalid_legacy_path`), §8.5 S3 (`copy_failed`
 * and OS-classified subtypes), §8.5 S4 (`corrupt_legacy`), §8.5 S6
 * (`finalize_failed`), §8.3 step 1a (`user_skipped_after_disk_full`,
 * `corrupt_skipped`).
 */
export const MIGRATION_FAILURE_REASONS = [
  'invalid_legacy_path',
  'copy_failed',
  'corrupt_legacy',
  'finalize_failed',
  'disk_full',
  'permission_denied',
  'user_skipped_after_disk_full',
  'corrupt_skipped',
] as const;

export type MigrationFailureReason = (typeof MIGRATION_FAILURE_REASONS)[number];

/**
 * Migration started — emitted at S3 START in §8.5.
 *
 * Carries enough context for the modal to render an initial line and
 * for support post-mortem to correlate against the daemon log
 * (`traceId` chains every subsequent `migration_*` log line).
 */
export interface MigrationStartedEvent {
  readonly event: typeof MIGRATION_EVENT_NAMES.started;
  readonly traceId: string;
  /** Resolved legacy ccsm.db path (frag-8 §8.5 S1). */
  readonly sourcePath: string;
  /** Source schema version (PRAGMA user_version on legacy db, e.g. 1). */
  readonly fromVersion: number;
  /** Target schema version (e.g. 3 for v0.3). */
  readonly toVersion: number;
  /** Daemon wall-clock ms when migration started. */
  readonly startedAt: number;
}

/**
 * Migration completed — emitted at the end of §8.5 S8 just before the
 * state file is stamped `reason='migrated'`.
 */
export interface MigrationCompletedEvent {
  readonly event: typeof MIGRATION_EVENT_NAMES.completed;
  readonly traceId: string;
  readonly fromVersion: number;
  readonly toVersion: number;
  /** Wall-clock duration since the started event. */
  readonly durationMs: number;
  /**
   * Total rows copied from legacy db. The legacy schema is
   * `app_state(key, value, updated_at)` so this is the count of
   * key/value rows preserved.
   */
  readonly rowsConverted: number;
}

/**
 * Migration failed — single event class per §8.6; renderer dispatches
 * to a single fatal-error modal (`migration.modal.failed.*` i18n
 * namespace). `reason` is the classified code; `errorMessage` and
 * `errorCode` carry the raw OS / SQLite detail for support tooling.
 */
export interface MigrationFailedEvent {
  readonly event: typeof MIGRATION_EVENT_NAMES.failed;
  readonly traceId: string;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly reason: MigrationFailureReason;
  /** Raw error message (already user-safe per §8.6 — no PII). */
  readonly errorMessage: string;
  /** OS / SQLite errno or short code, when available (e.g. 'ENOSPC'). */
  readonly errorCode?: string;
}

/**
 * Discriminated union over the three migration events. Switch on
 * `event` to narrow:
 *
 * ```ts
 * function handle(e: MigrationEvent) {
 *   switch (e.event) {
 *     case MIGRATION_EVENT_NAMES.started:   // e: MigrationStartedEvent
 *     case MIGRATION_EVENT_NAMES.completed: // e: MigrationCompletedEvent
 *     case MIGRATION_EVENT_NAMES.failed:    // e: MigrationFailedEvent
 *   }
 * }
 * ```
 */
export type MigrationEvent =
  | MigrationStartedEvent
  | MigrationCompletedEvent
  | MigrationFailedEvent;

/**
 * Type guard helpers — useful for consumers (T33) that subscribe to a
 * single event name and want to narrow without an exhaustive switch.
 * Pure structural checks; no runtime schema validation.
 */
export function isMigrationStarted(e: MigrationEvent): e is MigrationStartedEvent {
  return e.event === MIGRATION_EVENT_NAMES.started;
}

export function isMigrationCompleted(e: MigrationEvent): e is MigrationCompletedEvent {
  return e.event === MIGRATION_EVENT_NAMES.completed;
}

export function isMigrationFailed(e: MigrationEvent): e is MigrationFailedEvent {
  return e.event === MIGRATION_EVENT_NAMES.failed;
}
