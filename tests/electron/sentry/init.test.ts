// tests/electron/sentry/init.test.ts
//
// Phase 2 + Phase 4 crash observability — main-process Sentry init.
// Verifies:
//   * no-op when DSN env / build-info absent (OSS-fork leak prevention)
//   * no-op when DSN is the literal `***REDACTED***` placeholder
//   * init called with `tags.surface = 'main'` when DSN configured
//   * SENTRY_DSN_MAIN takes precedence over the legacy SENTRY_DSN env
//   * Phase 4 consent gate: pending / opted-out → no init even with valid DSN

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as SentryMain from '@sentry/electron/main';

vi.mock('@sentry/electron/main', () => ({ init: vi.fn() }));
vi.mock('electron', () => ({
  app: { getVersion: () => '0.3.0-test', isPackaged: false },
}));

// Mutable consent stub — tests reach into this to flip the gate.
const consentRef = { value: 'opted-in' as 'pending' | 'opted-in' | 'opted-out' };
vi.mock('../../../electron/prefs/crashConsent', () => ({
  loadCrashConsent: () => consentRef.value,
  isCrashUploadAllowed: () => consentRef.value === 'opted-in',
}));

const init = SentryMain.init as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  init.mockReset();
  vi.unstubAllEnvs();
  consentRef.value = 'opted-in';
});

describe('initSentry (electron-main)', () => {
  it('returns early (no Sentry.init call) when no DSN is configured anywhere', async () => {
    vi.stubEnv('SENTRY_DSN_MAIN', '');
    vi.stubEnv('SENTRY_DSN', '');
    const { initSentry } = await import('../../../electron/sentry/init');
    initSentry();
    expect(init).not.toHaveBeenCalled();
  });

  it('returns early when DSN is the literal "***REDACTED***" placeholder', async () => {
    vi.stubEnv('SENTRY_DSN_MAIN', '***REDACTED***');
    vi.stubEnv('SENTRY_DSN', '');
    const { initSentry } = await import('../../../electron/sentry/init');
    initSentry();
    expect(init).not.toHaveBeenCalled();
  });

  it('initializes with tags.surface = "main" when SENTRY_DSN_MAIN is set', async () => {
    vi.stubEnv('SENTRY_DSN_MAIN', 'https://abc@o0.ingest.sentry.io/1');
    vi.stubEnv('SENTRY_DSN', '');
    const { initSentry } = await import('../../../electron/sentry/init');
    initSentry();
    expect(init).toHaveBeenCalledTimes(1);
    const arg = init.mock.calls[0]![0];
    expect(arg.dsn).toBe('https://abc@o0.ingest.sentry.io/1');
    expect(arg.release).toBe('0.3.0-test');
    expect(arg.initialScope?.tags?.surface).toBe('main');
  });

  it('falls back to legacy SENTRY_DSN when SENTRY_DSN_MAIN is unset', async () => {
    vi.stubEnv('SENTRY_DSN_MAIN', '');
    vi.stubEnv('SENTRY_DSN', 'https://legacy@o0.ingest.sentry.io/2');
    const { initSentry } = await import('../../../electron/sentry/init');
    initSentry();
    expect(init).toHaveBeenCalledTimes(1);
    expect(init.mock.calls[0]![0].dsn).toBe('https://legacy@o0.ingest.sentry.io/2');
    expect(init.mock.calls[0]![0].initialScope?.tags?.surface).toBe('main');
  });

  it('SENTRY_DSN_MAIN wins over legacy SENTRY_DSN', async () => {
    vi.stubEnv('SENTRY_DSN_MAIN', 'https://winner@o0.ingest.sentry.io/3');
    vi.stubEnv('SENTRY_DSN', 'https://loser@o0.ingest.sentry.io/4');
    const { initSentry } = await import('../../../electron/sentry/init');
    initSentry();
    expect(init.mock.calls[0]![0].dsn).toBe('https://winner@o0.ingest.sentry.io/3');
  });

  // Phase 4 consent gate.
  it('returns early when consent is "pending", even with a valid DSN', async () => {
    vi.stubEnv('SENTRY_DSN_MAIN', 'https://abc@o0.ingest.sentry.io/1');
    consentRef.value = 'pending';
    const { initSentry } = await import('../../../electron/sentry/init');
    initSentry();
    expect(init).not.toHaveBeenCalled();
  });

  it('returns early when consent is "opted-out", even with a valid DSN', async () => {
    vi.stubEnv('SENTRY_DSN_MAIN', 'https://abc@o0.ingest.sentry.io/1');
    consentRef.value = 'opted-out';
    const { initSentry } = await import('../../../electron/sentry/init');
    initSentry();
    expect(init).not.toHaveBeenCalled();
  });

  // Reverse-verify: we drop the gate by forcing consent='opted-in' even
  // though the real-world setting in this scenario would be 'opted-out'.
  // The opposite assertion (init NOT called) flips and the test catches it.
  it('reverse-verify: with the gate forced open, init runs (proves the gate is what stops it)', async () => {
    vi.stubEnv('SENTRY_DSN_MAIN', 'https://abc@o0.ingest.sentry.io/1');
    consentRef.value = 'opted-in';
    const { initSentry } = await import('../../../electron/sentry/init');
    initSentry();
    expect(init).toHaveBeenCalledTimes(1);
  });
});
