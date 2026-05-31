import { describe, it, expect, vi } from 'vitest';
import http from 'node:http';
import { runOauthLoopback } from '../oauthLoopback';

const ORIGIN = 'https://ccsm-worker.example.workers.dev';

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });
}

function portFromStartUrl(startUrl: string): number {
  return Number(new URL(startUrl).searchParams.get('port'));
}

describe('runOauthLoopback', () => {
  it('opens the desktop-start url with the assigned port and resolves the authCode', async () => {
    let startUrl = '';
    const openExternal = vi.fn(async (url: string) => {
      startUrl = url;
      const port = portFromStartUrl(url);
      // simulate the Worker 302 landing on the loopback
      await get(`http://127.0.0.1:${port}/?authCode=AC123`);
    });

    const result = await runOauthLoopback({ workerOrigin: ORIGIN, openExternal, timeoutMs: 2000 });

    expect(result).toEqual({ authCode: 'AC123' });
    expect(startUrl.startsWith(`${ORIGIN}/auth/github/desktop-start?port=`)).toBe(true);
    expect(portFromStartUrl(startUrl)).toBeGreaterThanOrEqual(1024);
  });

  it('serves a close-the-window page on the loopback', async () => {
    let pagePromise: Promise<{ status: number; body: string }> | null = null;
    const openExternal = async (url: string) => {
      pagePromise = get(`http://127.0.0.1:${portFromStartUrl(url)}/?authCode=X`);
      await pagePromise;
    };
    await runOauthLoopback({ workerOrigin: ORIGIN, openExternal, timeoutMs: 2000 });
    const page = await pagePromise!;
    expect(page.status).toBe(200);
    expect(page.body).toMatch(/close this window/i);
  });

  it('ignores non-root paths (e.g. favicon) without resolving', async () => {
    const openExternal = async (url: string) => {
      const port = portFromStartUrl(url);
      const fav = await get(`http://127.0.0.1:${port}/favicon.ico`);
      expect(fav.status).toBe(404);
      await get(`http://127.0.0.1:${port}/?authCode=REAL`);
    };
    const result = await runOauthLoopback({ workerOrigin: ORIGIN, openExternal, timeoutMs: 2000 });
    expect(result).toEqual({ authCode: 'REAL' });
  });

  it('rejects on timeout when no authCode arrives', async () => {
    const openExternal = vi.fn(async () => {
      /* never hits the loopback */
    });
    await expect(
      runOauthLoopback({ workerOrigin: ORIGIN, openExternal, timeoutMs: 60 }),
    ).rejects.toThrow(/timeout/i);
  });

  it('rejects when openExternal throws', async () => {
    const openExternal = vi.fn(async () => {
      throw new Error('no browser');
    });
    await expect(
      runOauthLoopback({ workerOrigin: ORIGIN, openExternal, timeoutMs: 2000 }),
    ).rejects.toThrow(/no browser/i);
  });
});
