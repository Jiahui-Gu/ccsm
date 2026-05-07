// Sessions Map <-> KV db wiring (Task #667).
//
// Why a separate module:
//   - http.mts already does HTTP routing + auth + static-serving; mixing in
//     debounce timers and JSON serialization makes it hard to read and harder
//     to unit-test in isolation.
//   - The persist surface is intentionally tiny: load on boot, schedule
//     debounced writes after mutations, and a synchronous flushNow for the
//     SIGINT path. By keeping it pure (in/out via parameters), the same
//     module is exercised both by http.mts and by a focused round-trip test.
//
// Storage shape:
//   key 'sessions' -> JSON string of `StubSession[]` (Array.from(map.values()))
//
// Invariants:
//   - cwd MUST be preserved. Spike #665 proved that `claude --resume` exits
//     with code 1 if the cwd at resume time differs from the original spawn
//     cwd. Round-tripping the StubSession.cwd field is therefore load-bearing.
//   - createdAt and alive must round-trip too — they show up in the REST
//     ListSessionsResponse the frontend renders on boot.

import type { KvDb } from './db.mjs';
import type { StubSession } from './http.mjs';

const SESSIONS_KEY = 'sessions';

/** Default debounce window for batching rapid writes. 250ms is short enough
 *  that a normal user-typed POST/DELETE feels durable, long enough to
 *  collapse a burst of e.g. five DELETE calls into one disk write. */
export const DEFAULT_DEBOUNCE_MS = 250;

export interface PersistController {
  /** Mutate-then-call: marks the in-memory map dirty and (re)arms the timer. */
  scheduleFlush(): void;
  /** Synchronous flush. Cancels any pending debounce, writes immediately.
   *  Safe to call from a SIGINT/beforeExit handler. */
  flushNow(): void;
  /** Test/debug: returns true while a debounce timer is armed. */
  hasPending(): boolean;
}

export interface CreatePersistOptions {
  db: KvDb;
  sessions: Map<string, StubSession>;
  debounceMs?: number;
}

/**
 * Read the persisted sessions blob from `db` and rehydrate `sessions` in
 * place. Missing key (first boot) -> empty map + no warning. Parse failure
 * or wrong shape -> empty map + console.warn so an operator can spot it
 * in logs without the daemon refusing to boot.
 */
export function loadSessionsFromDb(
  db: KvDb,
  sessions: Map<string, StubSession>,
): void {
  const raw = db.get(SESSIONS_KEY);
  if (raw === null) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn('[ccsm] sessions blob unparseable, starting empty:', err);
    return;
  }
  if (!Array.isArray(parsed)) {
    console.warn('[ccsm] sessions blob is not an array, starting empty');
    return;
  }
  for (const entry of parsed) {
    if (!isStubSession(entry)) {
      console.warn('[ccsm] skipping malformed session entry:', entry);
      continue;
    }
    sessions.set(entry.sid, entry);
  }
}

function isStubSession(v: unknown): v is StubSession {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.sid !== 'string' || o.sid.length === 0) return false;
  if (typeof o.createdAt !== 'number') return false;
  if (typeof o.alive !== 'boolean') return false;
  if (o.cwd !== undefined && typeof o.cwd !== 'string') return false;
  return true;
}

/** Serialize the current map values to the JSON shape we persist. */
function serialize(sessions: Map<string, StubSession>): string {
  // Iteration order of Map.values() is insertion order, which matches the
  // order the frontend's listSessions surface returns today. Preserve it
  // across restarts so the UI doesn't shuffle on reboot.
  return JSON.stringify(Array.from(sessions.values()));
}

/**
 * Build a controller that owns the debounced-write timer for `sessions`.
 * Caller is responsible for invoking scheduleFlush() after each mutation
 * and flushNow() during shutdown.
 */
export function createPersistController(
  opts: CreatePersistOptions,
): PersistController {
  const { db, sessions } = opts;
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  let timer: NodeJS.Timeout | null = null;

  function doWrite(): void {
    try {
      db.set(SESSIONS_KEY, serialize(sessions));
    } catch (err) {
      // A failed write is logged but not thrown — losing one debounce tick
      // is preferable to crashing the daemon mid-request. The next mutation
      // will reschedule and retry.
      console.warn('[ccsm] sessions persist failed:', err);
    }
  }

  function scheduleFlush(): void {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      doWrite();
    }, debounceMs);
    // Don't keep the event loop alive solely for a pending flush — the
    // shutdown path calls flushNow() explicitly, and an idle daemon should
    // be allowed to exit if nothing else is holding it open.
    timer.unref?.();
  }

  function flushNow(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    doWrite();
  }

  function hasPending(): boolean {
    return timer !== null;
  }

  return { scheduleFlush, flushNow, hasPending };
}
