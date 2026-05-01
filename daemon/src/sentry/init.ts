// daemon/src/sentry/init.ts
//
// Phase 2 crash observability (spec §5.2 / §6, plan Task 8).
//
// Reads `CCSM_DAEMON_SENTRY_DSN` (forwarded by electron/daemon/supervisor.ts
// at spawn time) at runtime. Empty / unset / `***REDACTED***` placeholder →
// no-op so OSS forks and dev builds stay opt-in.
//
// Tag every event with `surface: 'daemon'` so a single Sentry project can
// de-mux daemon events from main/renderer events emitted by
// electron/sentry/init.ts and src/index.tsx.
//
// `bootNonce` is also tagged so a marker file written by
// daemon/src/crash/handlers.ts can be cross-referenced with the Sentry event
// it produced (the supervisor adopts the marker into the umbrella incident
// dir on next boot, see spec §5.3).
//
// Sentry SDK access is funneled through the `SentryLike` interface so tests
// can inject a spy without depending on vitest's module-mock plumbing
// (npm workspaces sometimes resolve `@sentry/node` to the daemon-local
// `daemon/node_modules/@sentry/node` copy which sits outside vi.mock's
// path-based interception).

import * as RealSentry from '@sentry/node';

const REDACTED = '***REDACTED***';

export interface DaemonSentryOpts {
  dsn: string;
  release: string;
  bootNonce: string;
  /** Test seam — defaults to the real `@sentry/node` namespace. */
  sentry?: SentryLike;
}

export interface SentryLike {
  init: (opts: Record<string, unknown>) => unknown;
  flush: (timeoutMs?: number) => Promise<boolean>;
  captureException: (err: unknown) => unknown;
}

let active: SentryLike | undefined;

/**
 * Initialize Sentry for the daemon process. No-op when DSN is empty / unset
 * / the redacted placeholder.
 *
 * Returns `true` if init was performed, `false` if short-circuited.
 */
export function initDaemonSentry(opts: DaemonSentryOpts): boolean {
  const dsn = (opts.dsn ?? '').trim();
  if (!dsn || dsn === REDACTED) return false;
  const sentry: SentryLike = opts.sentry ?? (RealSentry as unknown as SentryLike);
  sentry.init({
    dsn,
    release: opts.release,
    initialScope: {
      tags: {
        surface: 'daemon',
        bootNonce: opts.bootNonce,
      },
    },
  });
  active = sentry;
  return true;
}

/** Best-effort flush before process.exit so in-flight envelopes don't drop. */
export async function flushDaemonSentry(timeoutMs = 2000): Promise<void> {
  const sentry = active ?? (RealSentry as unknown as SentryLike);
  try {
    await sentry.flush(timeoutMs);
  } catch {
    /* swallow — flush failure must never block shutdown */
  }
}

/** Wrapper around Sentry.captureException that swallows transport errors. */
export function captureDaemonException(err: unknown): void {
  const sentry = active ?? (RealSentry as unknown as SentryLike);
  try {
    sentry.captureException(err);
  } catch {
    /* swallow */
  }
}

/** Test-only reset of the cached active SDK reference. */
export function _resetDaemonSentryForTesting(): void {
  active = undefined;
}
