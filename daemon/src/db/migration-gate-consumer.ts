// T35: MIGRATION_PENDING gate consumer.
//
// Spec refs:
//   - docs/superpowers/specs/v0.3-fragments/frag-8-sqlite-migration.md
//     §8.5 short-circuit scope (`migrationState: 'pending' | 'completed' | 'failed'`)
//   - Same fragment §8.6 (data RPCs return MIGRATION_PENDING; supervisor
//     RPCs respond normally with `migrationState` diagnostic field)
//   - daemon/src/envelope/migration-gate-interceptor.ts (T10 — pure decider
//     that consumes the boolean derived from this state)
//   - daemon/src/db/migration-events.ts (T30 — discriminated union the
//     producer T29 emits; this module's setState() is what call sites use
//     to flip state on those events)
//
// Single Responsibility (producer / decider / sink): this module is a
// pure state holder. It does NOT
//   - perform any I/O (no marker-file read, no socket write, no logging),
//   - emit migration events (T30 owns the wire contract; producers call
//     setState here AND emit a MigrationEvent on the IPC bus separately),
//   - decide whether an RPC may proceed (T10 migrationGateInterceptor is
//     the decider; it asks `isMigrationPending()` here),
//   - re-derive the boolean from on-disk markers (frag-8 §8.3 owns marker
//     read; the boot path translates the marker into the initial setState
//     call).
//
// Consumers:
//   1. T10 migrationGateInterceptor reads `isMigrationPending()` per RPC.
//   2. Supervisor RPCs (`/healthz`, `/stats`, `/version`, `ping()`) read
//      `getMigrationState()` to populate the diagnostic field per §8.5.
//   3. The Electron-main daemon bridge subscribes to be notified when state
//      transitions, so it can drive the renderer-blocking modal (frag-8 §8.6).
//
// State semantics (spec frag-8 §8.5 + §8.6):
//   - 'idle'      → no migration in flight; no marker-driven blocking.
//                   This is the boot-default and the post-completed state
//                   for installs that never had a v0.2 db.
//   - 'pending'   → migration runner is in progress; data RPCs MUST be
//                   short-circuited with `MIGRATION_PENDING`.
//   - 'completed' → migration finished successfully; data RPCs proceed
//                   normally. Reported as `migrationState: 'completed'`
//                   on supervisor RPC responses for diagnostics.
//   - 'failed'    → migration ran and failed; data RPCs stay blocked
//                   (the renderer surfaces the fatal-error modal per §8.6).
//                   The daemon stays UP so logs/IPC keep working.
//
// Only `pending` and `failed` block data-plane RPCs. The interceptor sees
// a single boolean (`isMigrationPending()`); the four-state surface is for
// the supervisor diagnostic field.

/**
 * Migration lifecycle state. See module header for semantics.
 *
 * Spec §8.5 short-circuit defines three states (pending / completed /
 * failed). 'idle' is added here as the explicit boot-default so the
 * type system can distinguish "never ran" from "ran successfully" for
 * the supervisor diagnostic. The wire format owned by §8.5 only
 * surfaces three values; the bridge can collapse `idle → completed` if
 * the diagnostic field needs to stay 3-valued.
 */
export type MigrationState = 'idle' | 'pending' | 'completed' | 'failed';

/** Subscriber callback. Invoked synchronously after every state change. */
export type MigrationStateListener = (state: MigrationState) => void;

/** Disposer returned by `subscribe()`. Idempotent. */
export type Unsubscribe = () => void;

/**
 * Pure state holder for the MIGRATION_PENDING gate.
 *
 * Construct one instance per daemon process (typically a module-level
 * singleton wired in the daemon entry). Tests should construct their
 * own instance to stay isolated.
 *
 * Thread/event-loop safety: setState + notify run synchronously on the
 * caller. Listeners are invoked in registration order. A listener that
 * throws does NOT prevent later listeners from being called (errors are
 * caught and rethrown via queueMicrotask so the producer call site stays
 * decoupled from sink failures).
 */
export class MigrationGateConsumer {
  private state: MigrationState = 'idle';
  private readonly listeners = new Set<MigrationStateListener>();

  /** Read the current state. Cheap; safe to call per-RPC. */
  getMigrationState(): MigrationState {
    return this.state;
  }

  /**
   * Convenience boolean for T10 migrationGateInterceptor: returns true
   * iff data-plane RPCs MUST be short-circuited. Matches the
   * `migrationPending` field on `MigrationGateContext`.
   *
   * 'pending' and 'failed' both block — see module header for rationale.
   */
  isMigrationPending(): boolean {
    return this.state === 'pending' || this.state === 'failed';
  }

  /**
   * Set the migration state and notify all subscribers if (and only if)
   * the value changed. No-op if `next === current`, so producers can
   * safely call this from idempotent re-emit paths without thrashing
   * the renderer modal.
   *
   * Listener errors are isolated: a throwing listener does not prevent
   * later listeners from running, but the error is re-raised on a
   * microtask so it surfaces in unhandled-rejection logs rather than
   * silently disappearing.
   */
  setMigrationState(next: MigrationState): void {
    if (this.state === next) return;
    this.state = next;
    // Snapshot listeners so an unsubscribe() inside a callback doesn't
    // skip a sibling. (Set iteration with concurrent mutation is
    // technically defined in JS but spelling it out is safer.)
    const snapshot = Array.from(this.listeners);
    for (const listener of snapshot) {
      try {
        listener(next);
      } catch (err) {
        queueMicrotask(() => {
          throw err;
        });
      }
    }
  }

  /**
   * Subscribe to state transitions. The listener is invoked AFTER every
   * setMigrationState call that actually changed the value (no initial
   * fire — call `getMigrationState()` if you need the current value at
   * subscription time).
   *
   * Returns an idempotent unsubscribe function.
   */
  subscribe(listener: MigrationStateListener): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Test-only helper: drop all subscribers. Production daemon never
   * needs this (process exit drops the whole instance). Kept on the
   * class rather than a separate _testing.ts surface because the
   * single-file SRP boundary outweighs the test-export hygiene.
   */
  clearSubscribersForTests(): void {
    this.listeners.clear();
  }
}
