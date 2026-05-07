// Screenshot helper for ccsm e2e (Task #664).
//
// `snap(page, testInfo, name)` writes BOTH a .png (full-page screenshot) and
// a .txt sibling containing structured page state (title, URL, visible text,
// data-testid inventory, captured console warnings/errors).
//
// Why both? The manager (Claude) verifying a PR cannot view rendered pixels
// reliably; reading the .txt gives a deterministic, diff-able view of what
// the user would see, while the .png stays available for human spot-checks
// and CI artifact uploads.

import type { Page, TestInfo } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOTS_ROOT = resolve(__dirname, '..', 'snapshots');

// Map of Page → console-log buffer. Installed lazily on first snap() call
// per page so callers do not need to wire listeners themselves.
const consoleBuffers = new WeakMap<Page, string[]>();

function attachConsoleCapture(page: Page): string[] {
  const existing = consoleBuffers.get(page);
  if (existing) return existing;

  const buf: string[] = [];
  consoleBuffers.set(page, buf);

  page.on('console', (msg) => {
    const type = msg.type();
    if (type !== 'warning' && type !== 'error') return;
    buf.push(`[${type}] ${msg.text()}`);
  });
  page.on('pageerror', (err) => {
    buf.push(`[pageerror] ${err.message}`);
  });

  return buf;
}

function sanitize(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'untitled';
}

export interface SnapResult {
  pngPath: string;
  txtPath: string;
}

export async function snap(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<SnapResult> {
  const consoleLogs = attachConsoleCapture(page);

  const dir = resolve(SNAPSHOTS_ROOT, sanitize(testInfo.title));
  await mkdir(dir, { recursive: true });

  const safeName = sanitize(name);
  const pngPath = resolve(dir, `${safeName}.png`);
  const txtPath = resolve(dir, `${safeName}.txt`);

  // Best-effort full-page screenshot. about:blank etc. may produce a tiny
  // image; that is fine — the .txt is the load-bearing artifact.
  //
  // Firefox enforces a hard 32767-pixel limit on either screenshot dimension
  // (Task #752: surfaced when xterm's measure-row container reflows tall on
  // firefox + the SPA layout, producing a fullPage taller than 32767 px and
  // failing with "Cannot take screenshot larger than 32767"). Fall back to a
  // viewport-only screenshot in that case so we still emit a non-empty .png
  // and continue the test — the .txt sibling is the load-bearing artifact.
  try {
    await page.screenshot({ path: pngPath, fullPage: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/larger than 32767|too large/i.test(msg)) {
      await page.screenshot({ path: pngPath, fullPage: false });
    } else {
      throw err;
    }
  }

  // Best-effort metadata capture. Each await is wrapped because some pages
  // (about:blank, error pages) throw on certain queries.
  const title = await safe(() => page.title(), '');
  const url = page.url();
  const visibleText = await safe(
    () => page.locator('body').innerText({ timeout: 2000 }),
    '',
  );
  const testIds = await safe(
    () =>
      page.evaluate(() => {
        const nodes = document.querySelectorAll('[data-testid]');
        const ids: string[] = [];
        nodes.forEach((n) => {
          const v = n.getAttribute('data-testid');
          if (v) ids.push(v);
        });
        return ids;
      }),
    [] as string[],
  );

  const body =
    `title: ${title}\n` +
    `url: ${url}\n` +
    `visible-text:\n${visibleText}\n\n` +
    `data-testids: ${testIds.join(', ')}\n` +
    `console-logs:\n${consoleLogs.join('\n')}\n`;

  await writeFile(txtPath, body, 'utf8');

  // Attach for HTML reporter convenience.
  await testInfo.attach(`${safeName}.png`, { path: pngPath, contentType: 'image/png' });
  await testInfo.attach(`${safeName}.txt`, { path: txtPath, contentType: 'text/plain' });

  return { pngPath, txtPath };
}

async function safe<T>(fn: () => Promise<T> | T, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}
