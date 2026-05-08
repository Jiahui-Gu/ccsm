// Daemon base URL resolution priority (Task #712 → Task #780 / S3-T5).

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DAEMON_BASE,
  resolveDaemonBase,
  resolveWsBase,
} from '../src/hostConfig';

describe('resolveDaemonBase', () => {
  it('defaults to the Cloudflare Pages tunnel URL when no ?daemon= is set', () => {
    // Task #780 (S3-T5): production default is the CF tunnel; the SPA is
    // always served from Pages and reaches the daemon via the Worker + DO.
    const got = resolveDaemonBase({ search: '' });
    expect(got).toBe(DEFAULT_DAEMON_BASE);
    expect(got).toBe('https://cc-sm.pages.dev');
  });

  it('URL ?daemon=http://127.0.0.1:9876 redirects back to local loopback', () => {
    // Escape hatch for dev / test / Tauri shell: opt out of the tunnel.
    const got = resolveDaemonBase({ search: '?daemon=http://127.0.0.1:9876' });
    expect(got).toBe('http://127.0.0.1:9876');
  });

  it('URL ?daemon=https://example.com redirects to that host', () => {
    const got = resolveDaemonBase({ search: '?daemon=https://example.com' });
    expect(got).toBe('https://example.com');
  });

  it('keeps the CF default when the SPA happens to be served same-origin (e.g. Vite dev server)', () => {
    // S2 used to fall back to window.location.origin on loopback hostnames.
    // S3 explicitly does NOT — opening http://localhost:5173 still talks to
    // the CF tunnel unless the user sets ?daemon=.
    const got = resolveDaemonBase({ search: '' });
    expect(got).toBe('https://cc-sm.pages.dev');
  });

  it('treats empty ?daemon= as missing and falls through to the default', () => {
    const got = resolveDaemonBase({ search: '?daemon=' });
    expect(got).toBe('https://cc-sm.pages.dev');
  });

  it('strips trailing slash so callers can append paths cleanly', () => {
    const got = resolveDaemonBase({ search: '?daemon=http://127.0.0.1:9876/' });
    expect(got).toBe('http://127.0.0.1:9876');
  });
});

describe('resolveWsBase', () => {
  it('defaults to wss://cc-sm.pages.dev when no ?daemon= is set', () => {
    const got = resolveWsBase({ search: '' });
    expect(got).toBe('wss://cc-sm.pages.dev');
  });

  it('matches https httpBase with wss:// scheme', () => {
    const got = resolveWsBase({ search: '?daemon=https://example.com' });
    expect(got).toBe('wss://example.com');
  });

  it('matches http httpBase with ws:// scheme (loopback override)', () => {
    const got = resolveWsBase({ search: '?daemon=http://127.0.0.1:9876' });
    expect(got).toBe('ws://127.0.0.1:9876');
  });
});
