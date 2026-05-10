// Daemon base URL resolution priority (Task #712 → #780 → #25 / smoke R-5).

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_DAEMON_BASE,
  getWsProtocol,
  resolveDaemonBase,
  resolveWsBase,
  resolveWsPath,
  WS_SUBPROTOCOL_PREFIX,
} from '../src/hostConfig';

describe('resolveDaemonBase', () => {
  it('defaults to the empty string (same-origin relative) when no ?daemon= is set', () => {
    // Task #25 (smoke R-5): production default went back to same-origin
    // relative. The Pages Function proxies `/token`, `/api/...`, and
    // `/ws/default` into the CF Worker tunnel from the SAME origin the SPA
    // is served from. Hard-coding `https://cc-sm.pages.dev` broke smoke
    // (SPA at 127.0.0.1:8788 → ERR_FAILED) and was redundant in cloud.
    const got = resolveDaemonBase({ search: '' });
    expect(got).toBe(DEFAULT_DAEMON_BASE);
    expect(got).toBe('');
  });

  it('URL ?daemon=http://127.0.0.1:9876 redirects to local loopback (Tauri / smoke probe escape hatch)', () => {
    const got = resolveDaemonBase({ search: '?daemon=http://127.0.0.1:9876' });
    expect(got).toBe('http://127.0.0.1:9876');
  });

  it('URL ?daemon=https://example.com redirects to that host', () => {
    const got = resolveDaemonBase({ search: '?daemon=https://example.com' });
    expect(got).toBe('https://example.com');
  });

  it('treats empty ?daemon= as missing and falls through to the same-origin default', () => {
    const got = resolveDaemonBase({ search: '?daemon=' });
    expect(got).toBe('');
  });

  it('strips trailing slash so callers can append paths cleanly', () => {
    const got = resolveDaemonBase({ search: '?daemon=http://127.0.0.1:9876/' });
    expect(got).toBe('http://127.0.0.1:9876');
  });
});

describe('resolveWsBase', () => {
  // window.location is jsdom-provided; tests that exercise the same-origin
  // synthesis path stub it for determinism.
  const originalWindow = (globalThis as { window?: unknown }).window;

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
  });

  it('synthesizes wss:// from window.location for the same-origin default', () => {
    (globalThis as { window?: unknown }).window = {
      location: { protocol: 'https:', host: 'ccsm-worker.jiahuigu.workers.dev', search: '' },
    };
    const got = resolveWsBase({ search: '' });
    expect(got).toBe('wss://ccsm-worker.jiahuigu.workers.dev');
  });

  it('synthesizes ws:// when the SPA is served over plain http (smoke / Vite dev)', () => {
    (globalThis as { window?: unknown }).window = {
      location: { protocol: 'http:', host: '127.0.0.1:8788', search: '' },
    };
    const got = resolveWsBase({ search: '' });
    expect(got).toBe('ws://127.0.0.1:8788');
  });

  it('matches https httpBase with wss:// scheme when ?daemon= overrides', () => {
    const got = resolveWsBase({ search: '?daemon=https://example.com' });
    expect(got).toBe('wss://example.com');
  });

  it('matches http httpBase with ws:// scheme (loopback override)', () => {
    const got = resolveWsBase({ search: '?daemon=http://127.0.0.1:9876' });
    expect(got).toBe('ws://127.0.0.1:9876');
  });

  it('returns the empty string when no window is available (SSR / Node)', () => {
    delete (globalThis as { window?: unknown }).window;
    const got = resolveWsBase({ search: '' });
    expect(got).toBe('');
  });
});

describe('resolveWsPath (Task #793, S3-G)', () => {
  it('defaults to /ws/default for cloud-tunnel deployment', () => {
    // Pages Function only routes literal `/ws/default` into the Worker + DO;
    // anything else (e.g. `/ws`) falls through to the SPA index.html and the
    // browser sees a hung handshake.
    expect(resolveWsPath({ search: '' })).toBe('/ws/default');
  });

  it('returns undefined when ?daemon= override is set (loopback / Tauri)', () => {
    // With a direct daemon base, the loopback daemon serves `/ws` (literal).
    // Returning undefined lets core's WsClient fall back to API_PATHS.ws.
    expect(resolveWsPath({ search: '?daemon=http://127.0.0.1:9876' })).toBeUndefined();
  });

  it('treats empty ?daemon= as missing and keeps the cloud default', () => {
    expect(resolveWsPath({ search: '?daemon=' })).toBe('/ws/default');
  });
});

describe('getWsProtocol (Task #782, S3-T6)', () => {
  it('returns ["ccsm.<token>"] when token reader yields a non-empty token', () => {
    const got = getWsProtocol({ getToken: () => 'abc-123' });
    expect(got).toEqual(['ccsm.abc-123']);
    expect(got[0].startsWith(WS_SUBPROTOCOL_PREFIX)).toBe(true);
  });

  it('returns [] when token reader yields null', () => {
    const got = getWsProtocol({ getToken: () => null });
    expect(got).toEqual([]);
  });

  it('returns [] when token reader yields empty string', () => {
    const got = getWsProtocol({ getToken: () => '' });
    expect(got).toEqual([]);
  });

  it('does not URL-encode the token (daemon UUID-shape charset is RFC 6455 safe)', () => {
    const got = getWsProtocol({ getToken: () => 'A1B2-c3d4-EF56' });
    expect(got).toEqual(['ccsm.A1B2-c3d4-EF56']);
  });

  it('integrates with sessionStorage-backed token reader (webHostConfig.getToken)', async () => {
    // Validates the sessionStorage path the SPA actually uses.
    const { TOKEN_STORAGE_KEY, webHostConfig } = await import('../src/hostConfig');
    const store = new Map<string, string>();
    const fakeSessionStorage = {
      getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => { store.clear(); },
      key: () => null,
      length: 0,
    };
    const originalSessionStorage = (globalThis as { sessionStorage?: Storage }).sessionStorage;
    const originalWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {};
    (globalThis as { sessionStorage?: unknown }).sessionStorage = fakeSessionStorage;
    try {
      store.set(TOKEN_STORAGE_KEY, 'sess-tok-1');
      const got = getWsProtocol({ getToken: webHostConfig.getToken });
      expect(got).toEqual(['ccsm.sess-tok-1']);
    } finally {
      if (originalSessionStorage === undefined) {
        delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
      } else {
        (globalThis as { sessionStorage?: unknown }).sessionStorage = originalSessionStorage;
      }
      if (originalWindow === undefined) {
        delete (globalThis as { window?: unknown }).window;
      } else {
        (globalThis as { window?: unknown }).window = originalWindow;
      }
    }
  });
});
