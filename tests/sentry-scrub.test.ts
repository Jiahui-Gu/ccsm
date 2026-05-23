// PR B Stage 2 — Sentry beforeSend / beforeBreadcrumb scrubber.
//
// Tests the pure scrubber helpers exported from `electron/sentry/init.ts`.
// We do NOT call `Sentry.init` — that requires a real Sentry/Electron
// runtime. Instead we exercise the exported scrubbing functions directly,
// which is what `Sentry.init`'s `beforeSend` / `beforeBreadcrumb` hooks
// invoke at send-time.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock heavy native deps so we can import the production init module without
// pulling Electron or the real Sentry SDK into jsdom. The scrubber helpers
// we're testing are pure functions that don't touch either.
vi.mock('@sentry/electron/main', () => ({
  init: vi.fn(),
  electronMinidumpIntegration: vi.fn(() => ({ name: 'ElectronMinidump' })),
}));
vi.mock('electron', () => ({ app: { getVersion: () => '0.0.0-test', isPackaged: false } }));
vi.mock('../electron/prefs/crashReporting', () => ({ loadCrashReportingOptOut: () => false }));

import { scrubSentryEvent, scrubBreadcrumb } from '../electron/sentry/init';
import { setHomeDir } from '../src/shared/scrub';

beforeEach(() => setHomeDir(null));

describe('scrubSentryEvent — exception stacktrace paths', () => {
  it('rewrites POSIX home paths in stack frame filename/abs_path', () => {
    const event = {
      exception: {
        values: [
          {
            type: 'TypeError',
            value: 'bad call at /Users/jiahui/secret/foo.ts',
            stacktrace: {
              frames: [
                {
                  filename: '/Users/jiahui/secret/foo.ts',
                  abs_path: '/Users/jiahui/secret/foo.ts',
                  module: 'foo',
                  function: 'doStuff',
                  lineno: 42,
                },
              ],
            },
          },
        ],
      },
    };
    const out = scrubSentryEvent(event) as typeof event;
    const frame = out.exception.values[0].stacktrace.frames[0];
    expect(frame.filename).toBe('[path]');
    expect(frame.abs_path).toBe('[path]');
    // Message-level path → [path].
    expect(out.exception.values[0].value).toBe('bad call at [path]');
    // lineno (non-string) untouched.
    expect(frame.lineno).toBe(42);
  });

  it('rewrites Windows drive paths in stack frames', () => {
    const event = {
      exception: {
        values: [
          {
            value: 'crash',
            stacktrace: {
              frames: [
                { filename: 'C:\\Users\\Jiahui\\app\\main.js', lineno: 1 },
              ],
            },
          },
        ],
      },
    };
    const out = scrubSentryEvent(event) as typeof event;
    expect(out.exception.values[0].stacktrace.frames[0].filename).toBe('[path]');
  });

  it('scrubs event.message', () => {
    const event = { message: 'failed reading /home/user/.config' };
    const out = scrubSentryEvent(event) as typeof event;
    expect(out.message).toBe('failed reading [path]');
  });

  it('scrubs forbidden fields from event.extra / contexts / tags', () => {
    const event = {
      extra: { sid: 'abc', text: 'leak me', cwd: '/Users/x/file.ts' },
      contexts: { runtime: { name: 'node', cmd: 'claude --resume' } },
      tags: { url: 'https://user:pw@host/x', sid: 'abc' },
    };
    const out = scrubSentryEvent(event) as typeof event;
    expect((out.extra as Record<string, unknown>).text).toBeUndefined();
    expect((out.extra as Record<string, unknown>).sid).toBe('abc');
    expect((out.extra as Record<string, unknown>).cwd).toBe('[path]');
    expect((out.contexts.runtime as Record<string, unknown>).cmd).toBeUndefined();
    expect((out.tags as Record<string, unknown>).url).toBeUndefined();
    expect((out.tags as Record<string, unknown>).sid).toBe('abc');
  });
});

describe('scrubBreadcrumb — drop on forbidden-only content', () => {
  it('drops a breadcrumb whose only data field was forbidden', () => {
    const crumb = {
      category: 'paste',
      data: { text: 'secret content' },
    };
    const out = scrubBreadcrumb(crumb);
    // After scrub, `data` is empty {} and there's no message → drop.
    expect(out).toBeNull();
  });

  it('keeps a breadcrumb whose message scrubs to a non-empty path token', () => {
    const crumb = {
      category: 'navigation',
      message: 'opened /Users/x/foo',
    };
    const out = scrubBreadcrumb(crumb);
    expect(out).not.toBeNull();
    expect(out!.message).toBe('opened [path]');
  });

  it('keeps a breadcrumb with surviving allowlisted data fields', () => {
    const crumb = {
      category: 'paste',
      data: { sid: 'abc', bytes: 42, text: 'secret' },
    };
    const out = scrubBreadcrumb(crumb) as Record<string, unknown> & {
      data: Record<string, unknown>;
    };
    expect(out).not.toBeNull();
    expect(out.data.sid).toBe('abc');
    expect(out.data.bytes).toBe(42);
    expect(out.data.text).toBeUndefined();
  });

  it('scrubs env-secret keys inside data', () => {
    const crumb = {
      message: 'env loaded',
      data: { ANTHROPIC_API_KEY: 'sk-leak', sid: 'abc' },
    };
    const out = scrubBreadcrumb(crumb) as Record<string, unknown> & {
      data: Record<string, unknown>;
    };
    expect(out!.data.ANTHROPIC_API_KEY).toBe('[redacted]');
    expect(out!.data.sid).toBe('abc');
  });
});

describe('scrubSentryEvent — defensive: never throws', () => {
  it('returns null when the input is structurally broken (drops the event)', () => {
    // Pass a getter that throws so the try/catch inside scrubSentryEvent trips.
    const bad: Record<string, unknown> = {};
    Object.defineProperty(bad, 'message', {
      get() {
        throw new Error('boom');
      },
    });
    const out = scrubSentryEvent(bad);
    expect(out).toBeNull();
  });
});
