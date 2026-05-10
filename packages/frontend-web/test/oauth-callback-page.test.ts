/**
 * R-53 (Task #175): static OAuth callback page tests.
 *
 * The static `/oauth/desktop/cb/index.html` page (deployed straight out of
 * Vite's `public/` directory) is responsible for:
 *   1. Reading `?code=&state=` from `window.location.search`.
 *   2. POSTing them to `/api/auth/desktop/exchange`.
 *   3. On success: composing `ccsm://oauth?token=...&refresh=...&state=...`
 *      and triggering `window.location.replace(deepLink)`.
 *   4. On failure: showing an error message + a "Try again" button.
 *   5. Showing a fallback "Open in App" button after a 5s delay so users can
 *      retry the deep link if the OS prompt was blocked.
 *
 * We exercise the inline script by reading the HTML file off disk, parsing
 * out the `<script>` body, and executing it in a jsdom window with a stubbed
 * `fetch` and a captured `location.replace`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PAGE_PATH = resolve(
  __dirname,
  '..',
  'public',
  'oauth',
  'desktop',
  'cb',
  'index.html',
);

function readPage(): string {
  return readFileSync(PAGE_PATH, 'utf8');
}

/** Extract the inline `<script>` body (the one that runs the exchange). */
function extractInlineScript(html: string): string {
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no inline <script> in page');
  return m[1]!;
}

/** Mount the page into the current jsdom document, capture location.replace,
 *  and run the inline script. */
async function runPage(opts: {
  search: string;
  fetchImpl: typeof globalThis.fetch;
}): Promise<{
  replaceCalls: string[];
  document: Document;
}> {
  const html = readPage();
  const stripped = html
    .replace(/<script>[\s\S]*?<\/script>/g, '')
    .replace(/^[\s\S]*?<html[^>]*>/i, '')
    .replace(/<\/html>[\s\S]*$/i, '');
  document.documentElement.innerHTML = stripped;

  const replaceCalls: string[] = [];
  vi.spyOn(window.location, 'replace').mockImplementation(
    (url: string | URL) => {
      replaceCalls.push(String(url));
    },
  );

  // Set the search via history.replaceState (jsdom backs location.search
  // with the current URL; `location.search = ` is read-only here).
  window.history.replaceState({}, '', '/oauth/desktop/cb' + opts.search);

  // Stub fetch on both window and global so the script (running in indirect
  // eval) finds it.
  window.fetch = opts.fetchImpl;
  globalThis.fetch = opts.fetchImpl;

  const script = extractInlineScript(html);
  // Indirect eval — runs in the global scope of the jsdom window.
  // eslint-disable-next-line no-eval
  (0, eval)(script);

  // Let microtasks (fetch promise resolution + .then chain) flush.
  for (let i = 0; i < 6; i++) await Promise.resolve();

  return { replaceCalls, document };
}

describe('static oauth callback page', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('on success: POSTs code+state to /api/auth/desktop/exchange and location.replaces into ccsm://oauth?token=...', async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('/api/auth/desktop/exchange');
      expect(init?.method).toBe('POST');
      const body = JSON.parse(init?.body as string) as { code: string; state: string };
      expect(body).toEqual({ code: 'gh-code-123', state: 'state-abc' });
      return new Response(
        JSON.stringify({
          tunnel_jwt: 'jwt.value.here',
          refresh_token: 'rrr',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const { replaceCalls } = await runPage({
      search: '?code=gh-code-123&state=state-abc',
      fetchImpl: fetchSpy as unknown as typeof globalThis.fetch,
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(replaceCalls).toHaveLength(1);
    const target = replaceCalls[0]!;
    expect(target.startsWith('ccsm://oauth?')).toBe(true);
    const params = new URLSearchParams(target.slice('ccsm://oauth?'.length));
    expect(params.get('token')).toBe('jwt.value.here');
    expect(params.get('refresh')).toBe('rrr');
    expect(params.get('state')).toBe('state-abc');
  });

  it('on missing code/state in URL: shows error, does NOT call fetch', async () => {
    const fetchSpy = vi.fn(async () => new Response('nope', { status: 500 }));
    const { document, replaceCalls } = await runPage({
      search: '?state=only',
      fetchImpl: fetchSpy as unknown as typeof globalThis.fetch,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(replaceCalls).toHaveLength(0);
    const errEl = document.getElementById('error') as HTMLElement;
    expect(errEl).not.toBeNull();
    expect(errEl.style.display).toBe('block');
    const msg = document.getElementById('errorMessage')!.textContent ?? '';
    expect(msg).toMatch(/Missing code or state/);
  });

  it('on GitHub error= param: shows the error message, no fetch', async () => {
    const fetchSpy = vi.fn(async () => new Response('nope', { status: 500 }));
    const { document } = await runPage({
      search: '?error=access_denied',
      fetchImpl: fetchSpy as unknown as typeof globalThis.fetch,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    const msg = document.getElementById('errorMessage')!.textContent ?? '';
    expect(msg).toMatch(/access_denied/);
  });

  it('on exchange 4xx: shows error with the response body, no location.replace', async () => {
    const fetchSpy = vi.fn(
      async () => new Response('unknown or used state', { status: 400 }),
    );
    const { document, replaceCalls } = await runPage({
      search: '?code=c&state=s',
      fetchImpl: fetchSpy as unknown as typeof globalThis.fetch,
    });
    // Let the .catch chain settle.
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(replaceCalls).toHaveLength(0);
    const errEl = document.getElementById('error') as HTMLElement;
    expect(errEl.style.display).toBe('block');
    const msg = document.getElementById('errorMessage')!.textContent ?? '';
    expect(msg).toMatch(/exchange failed \(400\)/);
    expect(msg).toMatch(/unknown or used state/);
    expect(document.getElementById('retry')).not.toBeNull();
  });

  it('after 5s the fallback "Open in App" button is shown with the deep link href', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ tunnel_jwt: 'tjt', refresh_token: 'rrr' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const { document } = await runPage({
      search: '?code=c&state=s',
      fetchImpl: fetchSpy as unknown as typeof globalThis.fetch,
    });

    const fallback = document.getElementById('fallback') as HTMLElement;
    // Before the 5s timer fires, fallback is hidden.
    expect(fallback.style.display).not.toBe('block');

    // Advance the fake timer past 5s.
    await vi.advanceTimersByTimeAsync(5100);
    expect(fallback.style.display).toBe('block');
    const href = (document.getElementById('open') as HTMLAnchorElement).getAttribute('href');
    expect(href!.startsWith('ccsm://oauth?')).toBe(true);
    expect(href).toContain('token=tjt');
    expect(href).toContain('refresh=rrr');
    expect(href).toContain('state=s');
  });

  it('page HTML is self-contained (no <script src>, no React, no module import)', () => {
    const html = readPage();
    expect(html).not.toMatch(/<script[^>]*\bsrc=/);
    expect(html).not.toMatch(/import\s+.*from/);
    expect(html).not.toMatch(/\breact\b/i);
  });
});
