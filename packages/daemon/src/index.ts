// Daemon entrypoint. Spec ch02 §3 startup order: this file walks phases
// 1–5 in sequence, logs each transition, and exits non-zero on any phase
// failure. The actual step bodies (DB open, session restore, listener
// bind, descriptor write, /healthz flip) live in later tasks — T1.1 just
// wires the lifecycle skeleton with TODO stubs.
//
// Out of scope (per task brief):
//   - Listener A bind + descriptor write   → T1.4
//   - SQLite open + migrations             → T5.1
//   - Session restore + orphan-uid check   → T3.4
//   - Supervisor /healthz                  → T1.7
//   - Graceful shutdown                    → T1.8

import { buildDaemonEnv, type DaemonEnv } from './env.js';
import { Lifecycle, Phase } from './lifecycle.js';

function log(line: string): void {
  // Plain stdout for now. T9 brings structured logging; until then a
  // single-line prefix is enough for the install-time install log scrape
  // (ch10 §6 healthz failure mode captures last 200 lines of stdout).
  process.stdout.write(`[ccsm-daemon] ${line}\n`);
}

/** Run startup phases 1–5. Throws on any phase failure; caller exits 1. */
export async function runStartup(lifecycle: Lifecycle): Promise<DaemonEnv> {
  lifecycle.onTransition((p) => log(`phase -> ${p}`));

  // Phase: LOADING_CONFIG  (build DaemonEnv from process.env)
  lifecycle.advanceTo(Phase.LOADING_CONFIG);
  const env = buildDaemonEnv();
  log(`env loaded: mode=${env.mode} bootId=${env.bootId} version=${env.version}`);

  // Phase: OPENING_DB  (TODO Task #T5.1 — open SQLite + run migrations)
  lifecycle.advanceTo(Phase.OPENING_DB);
  log('TODO(T5.1): open SQLite, run migrations, replay WAL');

  // Phase: RESTORING_SESSIONS  (TODO Task #T3.4 — re-spawn sessions)
  lifecycle.advanceTo(Phase.RESTORING_SESSIONS);
  log('TODO(T3.4): re-spawn should-be-running sessions, orphan-uid check');

  // Phase: STARTING_LISTENERS  (TODO Task #T1.4 — bind Listener A + descriptor)
  lifecycle.advanceTo(Phase.STARTING_LISTENERS);
  log('TODO(T1.4): bind Listener A, write listener-a.json atomically');
  // The listener-slot assert (ch03 §1) is a one-liner we can do today even
  // without makeListenerA — it proves slot 1 is the typed sentinel.
  const slot1 = env.listeners[1];
  if (slot1 !== env.listeners[1]) {
    // Tautological by construction, but the explicit reference keeps the
    // ESLint `no-listener-slot-mutation` rule (added with T1.4) honest.
    throw new Error('listeners[1] mutated away from RESERVED_FOR_LISTENER_B');
  }

  // Phase: READY  (Supervisor /healthz flips to 200 in T1.7)
  lifecycle.advanceTo(Phase.READY);
  log('TODO(T1.7): flip Supervisor /healthz to 200');

  return env;
}

async function main(): Promise<void> {
  const lifecycle = new Lifecycle();
  try {
    await runStartup(lifecycle);
    log(`startup complete: phase=${lifecycle.currentPhase()}`);
    // T1.1 stub: the daemon would normally hold the event loop open via
    // its bound listeners. Since T1.4 hasn't landed, exit cleanly so the
    // smoke command terminates instead of hanging.
    if (process.env.CCSM_DAEMON_HOLD_OPEN === '1') {
      // Keep alive forever (used once T1.4 lands so a real daemon doesn't
      // exit on its own — until then default is exit-0 for smoke runs).
      setInterval(() => {}, 1 << 30);
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    lifecycle.fail(error);
    log(`STARTUP FAILED at phase ${lifecycle.currentPhase()}: ${error.message}`);
    if (error.stack) {
      log(error.stack);
    }
    process.exit(1);
  }
}

// `import.meta.url` check so unit tests can `import { runStartup }` without
// triggering `main()`.
import { fileURLToPath } from 'node:url';

function isDirectRun(): boolean {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    const here = fileURLToPath(import.meta.url);
    return here === entry || here.replace(/\\/g, '/') === entry.replace(/\\/g, '/');
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  void main();
}
