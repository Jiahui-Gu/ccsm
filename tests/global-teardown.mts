// Diagnostic teardown for Task #164 — investigating CI test-step hang on
// ubuntu/macos/windows runners while the same commit + config completes
// in ~140s on a local Win11 box. Hypothesis A: vitest's `forks` pool
// leaks an active handle on Linux/macOS that keeps the parent process
// alive past the last test, so the runner sits in_progress until the
// job-level timeout kicks in.
//
// `why-is-node-running` dumps every async resource still keeping the
// event loop alive (timers, sockets, FS watchers, child processes,
// pino transports, etc.). We schedule the dump 5s AFTER vitest's own
// teardown completes; if the process is gone by then nothing prints
// (no leak), and if the runner is hanging we get a stack trace per
// retained handle in the CI logs. `.unref()` ensures this timer alone
// does not extend process lifetime.
//
// REMOVE this file (and the `globalTeardown` field in vitest.config.mts
// + the why-is-node-running devDep) once root cause is identified.
import whyIsNodeRunning from 'why-is-node-running';

export default async function teardown(): Promise<void> {
  setTimeout(() => {
    // eslint-disable-next-line no-console
    console.error('=== ACTIVE HANDLES (post-teardown +5s) ===');
    whyIsNodeRunning();
  }, 5000).unref();
}
