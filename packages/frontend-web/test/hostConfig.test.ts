// Daemon base URL resolution priority (Task #712).

import { describe, expect, it } from 'vitest';

import { DEFAULT_DAEMON_BASE, resolveDaemonBase } from '../src/hostConfig';

describe('resolveDaemonBase', () => {
  it('uses VITE_DAEMON_BASE when SPA is cross-origin (e.g. Pages)', () => {
    const got = resolveDaemonBase({
      search: '',
      hostname: 'cc-sm.pages.dev',
      origin: 'https://cc-sm.pages.dev',
      envBase: 'http://127.0.0.1:9876',
    });
    expect(got).toBe('http://127.0.0.1:9876');
  });

  it('URL ?daemon= override beats env var', () => {
    const got = resolveDaemonBase({
      search: '?daemon=http://127.0.0.1:8888',
      hostname: 'cc-sm.pages.dev',
      origin: 'https://cc-sm.pages.dev',
      envBase: 'http://127.0.0.1:9876',
    });
    expect(got).toBe('http://127.0.0.1:8888');
  });

  it('URL ?daemon= override beats loopback fallback', () => {
    // Daemon-embedded SPA on default port, but user wants to point at a
    // different daemon instance — override wins.
    const got = resolveDaemonBase({
      search: '?daemon=http://127.0.0.1:8888',
      hostname: '127.0.0.1',
      origin: 'http://127.0.0.1:9876',
      envBase: undefined,
    });
    expect(got).toBe('http://127.0.0.1:8888');
  });

  it('falls back to origin when hostname is 127.0.0.1 (daemon-embedded default)', () => {
    const got = resolveDaemonBase({
      search: '',
      hostname: '127.0.0.1',
      origin: 'http://127.0.0.1:9876',
      envBase: undefined,
    });
    expect(got).toBe('http://127.0.0.1:9876');
  });

  it('falls back to origin when hostname is localhost', () => {
    const got = resolveDaemonBase({
      search: '',
      hostname: 'localhost',
      origin: 'http://localhost:9876',
      envBase: undefined,
    });
    expect(got).toBe('http://localhost:9876');
  });

  it('falls back to origin on loopback even when env var is set (don\'t cross-origin from local)', () => {
    // Critical regress guard: existing daemon-embedded users must not
    // suddenly start making cross-origin requests just because a build
    // happened to inline VITE_DAEMON_BASE.
    const got = resolveDaemonBase({
      search: '',
      hostname: '127.0.0.1',
      origin: 'http://127.0.0.1:18080',
      envBase: 'http://127.0.0.1:9876',
    });
    expect(got).toBe('http://127.0.0.1:18080');
  });

  it('falls back to hard default when cross-origin and env var missing', () => {
    const got = resolveDaemonBase({
      search: '',
      hostname: 'cc-sm.pages.dev',
      origin: 'https://cc-sm.pages.dev',
      envBase: undefined,
    });
    expect(got).toBe(DEFAULT_DAEMON_BASE);
    expect(got).toBe('http://127.0.0.1:9876');
  });

  it('treats empty ?daemon= as missing and falls through', () => {
    const got = resolveDaemonBase({
      search: '?daemon=',
      hostname: 'cc-sm.pages.dev',
      origin: 'https://cc-sm.pages.dev',
      envBase: 'http://127.0.0.1:9876',
    });
    expect(got).toBe('http://127.0.0.1:9876');
  });

  it('strips trailing slash so callers can append paths cleanly', () => {
    const got = resolveDaemonBase({
      search: '',
      hostname: 'cc-sm.pages.dev',
      origin: 'https://cc-sm.pages.dev',
      envBase: 'http://127.0.0.1:9876/',
    });
    expect(got).toBe('http://127.0.0.1:9876');
  });
});
