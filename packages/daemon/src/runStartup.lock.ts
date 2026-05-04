// packages/daemon/src/runStartup.lock.ts
//
// Wave-2 Task #221 — runStartup boot-time wire-up assertion.
//
// Goal: prevent the "library shipped but never wired" regression class
// (the same root-cause Wave 0/1 was created to fix). At the END of
// `runStartup` the production daemon hands this module a `present`
// list of canonical component names; if any required name is absent we
// throw `Error("missing wired components: X, Y")` so the daemon exits
// non-zero and CI / install-time logs flag the regression immediately.
//
// `REQUIRED_COMPONENTS` is exported as a `readonly` const so the
// `daemon-boot-end-to-end.spec.ts` (Task #208) can import + assert the
// `result.wired` array equals it (rolling-extension contract — Task
// #225 layers more assertions on top of the same boot).
//
// SRP — pure decider. No I/O, no logging, no side effects beyond `throw`.
// The caller in `index.ts` does the production wiring + push; this file
// does nothing but compute "missing = required − present" and throw.

/**
 * Canonical list of v0.3 daemon components that MUST be wired by
 * `runStartup` before the boot is considered complete. Order is
 * stable so `daemon-boot-end-to-end.spec.ts` can do a deep-equality
 * assertion against `result.wired`.
 *
 * - `listener-a`     — Listener A is bound (T1.4 + T1.6 descriptor).
 * - `supervisor`     — Supervisor UDS server is bound (T1.7).
 * - `capture-sources`— `installCaptureSources` ran (ch09 §1).
 * - `crash-replayer` — `replayCrashRawOnBoot` ran (ch09 §6.2).
 * - `crash-rpc`      — `CrashService.GetCrashLog` Connect handler is
 *   installed on Listener A (Wave-3 #229 / audit #228 sub-task 2).
 *   Pre-#229 the entire `CrashService` returned `Unimplemented` despite
 *   the `crash_log` table being populated; this name asserts the wire
 *   handler is in the production overlay so a regression that drops
 *   the `crashDeps` pass-through fails boot.
 * - `settings-service` — `SettingsService.{GetSettings,UpdateSettings}`
 *   Connect handlers installed on Listener A (Wave-3 #349 / audit #228
 *   sub-task 9 / spec #337 §6.1 step 1). Pre-#349 the entire
 *   SettingsService returned `Unimplemented` despite the `settings`
 *   table being created by `001_initial.sql` from day one. This name
 *   asserts the wire handler is in the production overlay AND that
 *   the boot path UPSERT-ed the daemon-derived `user_home_path` /
 *   `detected_claude_default_model` rows (spec §5).
 * - `draft-service`  — `DraftService.{GetDraft,UpdateDraft}` Connect
 *   handlers installed on Listener A (Wave-3 #349 / spec #337 §6.1
 *   step 1). Drafts ride on the same `settings` table under key
 *   `draft:<session_id>` (spec §2.2 + draft.proto line 8).
 * - `write-coalescer`— SQLite write coalescer is wired (ch07 §5).
 *   v0.3 status: the coalescer module exists at
 *   `src/sqlite/coalescer.ts` but the per-session bridge that hands it
 *   pty-host deltas is not yet wired in `runStartup` (lands with the
 *   T6.x pty-host wave). Until then `runStartup` does NOT push
 *   `'write-coalescer'` and `assertWired` emits a warning to the
 *   supplied `warn` callback instead of throwing — see `WARN_ONLY`
 *   below. When the wire-up lands, drop it from `WARN_ONLY` and the
 *   assertion auto-promotes to a hard failure.
 */
export const REQUIRED_COMPONENTS: ReadonlyArray<string> = [
  'listener-a',
  'supervisor',
  'capture-sources',
  'crash-replayer',
  'crash-rpc',
  'settings-service',
  'draft-service',
  'write-coalescer',
] as const;

/**
 * Components that are REQUIRED on paper but whose wire-up has not yet
 * landed in `runStartup`. `assertWired` emits a warning for these
 * instead of throwing so the daemon still boots while we wait for the
 * owning task to land. When you wire one in, REMOVE it from this set —
 * the assertion will then auto-promote to a hard failure if a future
 * change accidentally drops the wiring.
 *
 * - `write-coalescer` → wired by T6.x pty-host bridge (TODO).
 */
const WARN_ONLY: ReadonlySet<string> = new Set(['write-coalescer']);

/**
 * Optional warn callback for the `WARN_ONLY` soft-fail path. The
 * default is a no-op so unit tests do not need to inject anything;
 * production `runStartup` injects a closure that calls the daemon
 * `log()` helper.
 */
export interface AssertWiredOptions {
  readonly warn?: (line: string) => void;
}

/**
 * Throws if any required component name is absent from `present`,
 * EXCEPT for components in `WARN_ONLY` which only emit a warning.
 *
 * Error message shape (intentionally stable so callers / log scrapers
 * can grep): `missing wired components: a, b, c`.
 */
export function assertWired(
  present: ReadonlyArray<string>,
  options: AssertWiredOptions = {},
): void {
  const presentSet = new Set(present);
  const missing: string[] = [];
  const softMissing: string[] = [];
  for (const name of REQUIRED_COMPONENTS) {
    if (presentSet.has(name)) continue;
    if (WARN_ONLY.has(name)) {
      softMissing.push(name);
    } else {
      missing.push(name);
    }
  }
  if (softMissing.length > 0 && options.warn) {
    options.warn(
      `assertWired: pending wire-up (TODO Task #T6.x): ${softMissing.join(', ')}`,
    );
  }
  if (missing.length > 0) {
    throw new Error(`missing wired components: ${missing.join(', ')}`);
  }
}
