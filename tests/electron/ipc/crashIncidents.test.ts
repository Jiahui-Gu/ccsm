// tests/electron/ipc/crashIncidents.test.ts
//
// Phase 4 crash observability — "Send last crash report" IPC behaviour.
// Verifies:
//   * getLastIncidentSummary picks the newest incident dir
//   * alreadySent reflects the `.uploaded` marker
//   * sendIncident refuses when no incident found / already-sent / consent
//     not granted
//   * sendIncident calls captureMessage with attachments + writes the marker
//     on success

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// We mock the consent module so the test controls the gate.
const consentRef = { allowed: true };
vi.mock('../../../electron/prefs/crashConsent', () => ({
  isCrashUploadAllowed: () => consentRef.allowed,
}));

// `electron` and `@sentry/electron/main` are pulled in transitively by
// crashIncidents.ts but we never call into them in these unit tests
// (sendIncident receives the SentryLike spy directly). Stub minimally.
vi.mock('electron', () => ({ app: {} }));
vi.mock('@sentry/electron/main', () => ({
  captureMessage: vi.fn(),
  flush: vi.fn().mockResolvedValue(true),
}));

import { getLastIncidentSummary, sendIncident } from '../../../electron/ipc/crashIncidents';

let tmpRoot: string;

function mkIncident(name: string, files: Record<string, string>, mtime?: number): string {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [fname, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, fname), body, 'utf8');
  }
  if (mtime !== undefined) {
    fs.utimesSync(dir, mtime / 1000, mtime / 1000);
  }
  return dir;
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-crash-test-'));
  consentRef.allowed = true;
});

describe('getLastIncidentSummary', () => {
  it('returns null when crash root is empty', () => {
    expect(getLastIncidentSummary(tmpRoot)).toBeNull();
  });

  it('returns null when crash root does not exist', () => {
    expect(getLastIncidentSummary(path.join(tmpRoot, 'missing'))).toBeNull();
  });

  it('picks the newest incident dir by mtime', () => {
    mkIncident('older', { 'meta.json': JSON.stringify({ incidentId: 'A', ts: '2026-04-30T00:00:00Z', surface: 'main' }) }, Date.now() - 10000);
    mkIncident('newer', { 'meta.json': JSON.stringify({ incidentId: 'B', ts: '2026-05-01T00:00:00Z', surface: 'daemon-exit' }) }, Date.now());
    const got = getLastIncidentSummary(tmpRoot);
    expect(got?.id).toBe('B');
    expect(got?.surface).toBe('daemon-exit');
    expect(got?.alreadySent).toBe(false);
  });

  it('reports alreadySent=true when .uploaded marker exists', () => {
    mkIncident('inc1', {
      'meta.json': JSON.stringify({ incidentId: 'X', ts: '2026-05-01', surface: 'main' }),
      '.uploaded': '{}',
    });
    const got = getLastIncidentSummary(tmpRoot);
    expect(got?.alreadySent).toBe(true);
  });

  it('falls back to dir name when meta.json is missing/corrupt', () => {
    mkIncident('inc-no-meta', { 'stderr-tail.txt': 'oops' });
    const got = getLastIncidentSummary(tmpRoot);
    expect(got?.id).toBe('inc-no-meta');
    expect(got?.surface).toBe('unknown');
  });

  it('skips dotfiles and underscore-prefixed dirs (e.g. _dmp-staging)', () => {
    fs.mkdirSync(path.join(tmpRoot, '_dmp-staging'), { recursive: true });
    expect(getLastIncidentSummary(tmpRoot)).toBeNull();
  });
});

describe('sendIncident', () => {
  function makeFakeSentry() {
    const captureMessage = vi.fn().mockReturnValue('event-123');
    const flush = vi.fn().mockResolvedValue(true);
    return { captureMessage, flush };
  }

  it('refuses when incident dir is missing', async () => {
    const sentry = makeFakeSentry();
    const res = await sendIncident(path.join(tmpRoot, 'nope'), sentry);
    expect(res).toEqual({ ok: false, reason: 'incident-not-found' });
    expect(sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('refuses when .uploaded marker already present', async () => {
    const dir = mkIncident('inc1', {
      'meta.json': '{}',
      '.uploaded': '{}',
    });
    const sentry = makeFakeSentry();
    const res = await sendIncident(dir, sentry);
    expect(res).toEqual({ ok: false, reason: 'already-sent' });
    expect(sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('refuses when consent is not granted', async () => {
    consentRef.allowed = false;
    const dir = mkIncident('inc1', { 'meta.json': '{}' });
    const sentry = makeFakeSentry();
    const res = await sendIncident(dir, sentry);
    expect(res).toEqual({ ok: false, reason: 'consent-not-granted' });
    expect(sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('uploads attachments and writes the .uploaded marker on success', async () => {
    const dir = mkIncident('inc1', {
      'meta.json': '{"incidentId":"X"}',
      'stderr-tail.txt': 'last 200 lines\n',
      'README.txt': 'human summary\n',
    });
    const sentry = makeFakeSentry();
    const res = await sendIncident(dir, sentry);
    expect(res.ok).toBe(true);
    expect((res as { eventId: string }).eventId).toBe('event-123');
    expect(sentry.captureMessage).toHaveBeenCalledTimes(1);
    const hint = sentry.captureMessage.mock.calls[0]![1] as { attachments: Array<{ filename: string }> };
    const names = hint.attachments.map((a) => a.filename).sort();
    expect(names).toEqual(['README.txt', 'meta.json', 'stderr-tail.txt']);
    expect(sentry.flush).toHaveBeenCalled();
    // Marker written, so a second send is refused.
    expect(fs.existsSync(path.join(dir, '.uploaded'))).toBe(true);
    const second = await sendIncident(dir, makeFakeSentry());
    expect(second).toEqual({ ok: false, reason: 'already-sent' });
  });

  it('caps attachment size at 1 MB so a giant dmp does not blow the envelope', async () => {
    const dir = mkIncident('inc1', { 'meta.json': '{}' });
    // Write a 2 MB file alongside.
    const big = Buffer.alloc(2 * 1024 * 1024, 0);
    fs.writeFileSync(path.join(dir, 'frontend.dmp'), big);
    const sentry = makeFakeSentry();
    await sendIncident(dir, sentry);
    const hint = sentry.captureMessage.mock.calls[0]![1] as { attachments: Array<{ filename: string }> };
    const names = hint.attachments.map((a) => a.filename);
    expect(names).toContain('meta.json');
    expect(names).not.toContain('frontend.dmp');
  });
});
