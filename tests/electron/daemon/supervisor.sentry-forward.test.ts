// tests/electron/daemon/supervisor.sentry-forward.test.ts
//
// Phase 2 crash observability (spec §6, plan Task 8) — supervisor must
// forward `CCSM_DAEMON_SENTRY_DSN` to the daemon child via the spawn env
// so daemon/src/sentry/init.ts can route uncaught/unhandled errors.
//
// We inject a fake spawn fn (test seam) and assert the env block.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawnDaemon, resolveDaemonSentryDsn } from '../../../electron/daemon/supervisor';

function fakeSpawn() {
  const calls: Array<{ binary: string; args: readonly string[]; options: any }> = [];
  const fn = ((binary: string, args: readonly string[], options: any) => {
    calls.push({ binary, args, options });
    const child: any = new EventEmitter();
    child.stdout = null;
    child.stderr = null;
    return child;
  }) as any;
  return { fn, calls };
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  delete process.env.SENTRY_DSN_DAEMON;
  delete process.env.SENTRY_DSN;
  delete process.env.CCSM_DAEMON_SENTRY_DSN;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('spawnDaemon DSN forwarding', () => {
  it('forwards CCSM_DAEMON_SENTRY_DSN from SENTRY_DSN_DAEMON env', () => {
    process.env.SENTRY_DSN_DAEMON = 'https://daemon@o0.ingest.sentry.io/9';
    const { fn, calls } = fakeSpawn();
    spawnDaemon({ binary: '/fake/ccsm-daemon', spawnFn: fn });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.binary).toBe('/fake/ccsm-daemon');
    expect(calls[0]!.options.env.CCSM_DAEMON_SENTRY_DSN).toBe('https://daemon@o0.ingest.sentry.io/9');
  });

  it('falls back to SENTRY_DSN when SENTRY_DSN_DAEMON is unset', () => {
    process.env.SENTRY_DSN = 'https://legacy@o0.ingest.sentry.io/8';
    const { fn, calls } = fakeSpawn();
    spawnDaemon({ binary: '/fake/ccsm-daemon', spawnFn: fn });
    expect(calls[0]!.options.env.CCSM_DAEMON_SENTRY_DSN).toBe('https://legacy@o0.ingest.sentry.io/8');
  });

  it('SENTRY_DSN_DAEMON wins over SENTRY_DSN', () => {
    process.env.SENTRY_DSN_DAEMON = 'https://win@o0.ingest.sentry.io/7';
    process.env.SENTRY_DSN = 'https://lose@o0.ingest.sentry.io/6';
    const { fn, calls } = fakeSpawn();
    spawnDaemon({ binary: '/fake/ccsm-daemon', spawnFn: fn });
    expect(calls[0]!.options.env.CCSM_DAEMON_SENTRY_DSN).toBe('https://win@o0.ingest.sentry.io/7');
  });

  it('forwards CCSM_DAEMON_SENTRY_DSN as empty string when nothing configured (still defined)', () => {
    const { fn, calls } = fakeSpawn();
    spawnDaemon({ binary: '/fake/ccsm-daemon', spawnFn: fn });
    expect(calls[0]!.options.env).toHaveProperty('CCSM_DAEMON_SENTRY_DSN');
    expect(calls[0]!.options.env.CCSM_DAEMON_SENTRY_DSN).toBe('');
  });

  it('explicit opts.dsn overrides env resolution', () => {
    process.env.SENTRY_DSN_DAEMON = 'https://env@o0.ingest.sentry.io/5';
    const { fn, calls } = fakeSpawn();
    spawnDaemon({ binary: '/fake/ccsm-daemon', dsn: 'https://override@o0.ingest.sentry.io/4', spawnFn: fn });
    expect(calls[0]!.options.env.CCSM_DAEMON_SENTRY_DSN).toBe('https://override@o0.ingest.sentry.io/4');
  });

  it('forwards CCSM_RUNTIME_ROOT when provided', () => {
    const { fn, calls } = fakeSpawn();
    spawnDaemon({ binary: '/fake/ccsm-daemon', runtimeRoot: '/tmp/runtime-x', spawnFn: fn });
    expect(calls[0]!.options.env.CCSM_RUNTIME_ROOT).toBe('/tmp/runtime-x');
  });

  it('preserves caller-supplied env entries (merged, not replaced)', () => {
    const { fn, calls } = fakeSpawn();
    spawnDaemon({
      binary: '/fake/ccsm-daemon',
      spawnFn: fn,
      spawnOptions: { env: { CUSTOM_KEY: 'custom-value' } },
    });
    expect(calls[0]!.options.env.CUSTOM_KEY).toBe('custom-value');
    expect(calls[0]!.options.env).toHaveProperty('CCSM_DAEMON_SENTRY_DSN');
  });
});

describe('resolveDaemonSentryDsn', () => {
  it('returns SENTRY_DSN_DAEMON when set', () => {
    process.env.SENTRY_DSN_DAEMON = 'https://primary@x/1';
    expect(resolveDaemonSentryDsn()).toBe('https://primary@x/1');
  });

  it('returns "" when nothing configured and no build-info', () => {
    expect(resolveDaemonSentryDsn()).toBe('');
  });
});
