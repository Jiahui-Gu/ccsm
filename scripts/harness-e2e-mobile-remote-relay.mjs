// Real Electron -> encrypted relay -> phone browser mirror proof.
//
// Local:  node scripts/harness-e2e-mobile-remote-relay.mjs
// Public: CCSM_RELAY_URL=https://<worker>.workers.dev node scripts/harness-e2e-mobile-remote-relay.mjs

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron as electron, chromium } from 'playwright';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const userDataDir = mkdtempSync(path.join(tmpdir(), 'ccsm-mirror-e2e-'));
const wranglerOutput = [];
let wrangler = null;
let electronApp = null;
let browser = null;

const MOBILE_CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('unable to reserve a relay port'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function waitFor(description, predicate, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`,
  );
}

function recordWranglerOutput(chunk) {
  for (const line of chunk.toString().split(/\r?\n/)) {
    if (line) wranglerOutput.push(line);
    if (wranglerOutput.length > 80) wranglerOutput.shift();
  }
}

async function startWrangler(port) {
  const child = spawn(
    process.execPath,
    [
      path.join(rootDir, 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
      'dev',
      '--config',
      path.join(rootDir, 'cloudflare', 'wrangler.jsonc'),
      '--ip',
      '127.0.0.1',
      '--port',
      String(port),
      '--local',
    ],
    {
      cwd: rootDir,
      env: { ...process.env, NO_COLOR: '1' },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  child.stdout.on('data', recordWranglerOutput);
  child.stderr.on('data', recordWranglerOutput);
  wrangler = child;
  const relayUrl = `http://127.0.0.1:${port}`;
  await waitFor('Wrangler relay', async () => {
    if (child.exitCode !== null) throw new Error(wranglerOutput.slice(-12).join('\n'));
    return (await fetch(relayUrl)).ok;
  });
  return relayUrl;
}

async function stopExactChild(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } else {
    try {
      process.kill(child.pid, 'SIGTERM');
    } catch {
      return;
    }
  }
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
}

async function serveLocalMobileAssets(context, relayUrl) {
  const origin = new URL(relayUrl).origin;
  const mobileDir = path.join(rootDir, 'dist', 'mobile');
  assert.ok(existsSync(path.join(mobileDir, 'index.html')), 'run npm run build first');
  await context.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/relay/')) {
      await route.continue();
      return;
    }
    const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const assetPath = path.resolve(mobileDir, relativePath);
    if (!assetPath.startsWith(`${mobileDir}${path.sep}`) || !existsSync(assetPath)) {
      await route.fulfill({ status: 404, body: 'Not Found' });
      return;
    }
    await route.fulfill({
      status: 200,
      body: readFileSync(assetPath),
      contentType:
        MOBILE_CONTENT_TYPES[path.extname(assetPath)] ?? 'application/octet-stream',
    });
  });
}

async function run() {
  const configuredRelayUrl = process.env.CCSM_RELAY_URL?.replace(/\/+$/, '');
  const relayUrl = configuredRelayUrl ?? (await startWrangler(await reservePort()));
  electronApp = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    cwd: rootDir,
    env: {
      ...process.env,
      CCSM_MOBILE_REMOTE_RELAY_URL: relayUrl,
      CCSM_PROD_BUNDLE: '1',
      DISABLE_AUTOUPDATER: '1',
    },
  });
  const desktop = await electronApp.firstWindow();
  await desktop.waitForLoadState('domcontentloaded');
  await desktop.bringToFront();
  await desktop.evaluate(() => {
    const tapTarget = document.createElement('button');
    tapTarget.id = 'mirror-e2e-tap';
    tapTarget.textContent = 'Mirror E2E';
    // Deliberately off vertical center (near the top edge) so this proves the
    // tap maps through real screen geometry rather than only through a
    // symmetric-letterbox-safe center point.
    Object.assign(tapTarget.style, {
      position: 'fixed',
      left: 'calc(50% - 100px)',
      top: '8%',
      width: '200px',
      height: '80px',
      zIndex: '2147483647',
    });
    tapTarget.addEventListener('click', () => {
      document.body.dataset.mirrorTap = 'yes';
    });
    const input = document.createElement('input');
    input.id = 'mirror-e2e-input';
    Object.assign(input.style, {
      position: 'fixed',
      left: '20px',
      top: '20px',
      zIndex: '2147483647',
    });
    input.addEventListener('keydown', (event) => {
      document.body.dataset.mirrorKey = event.key;
    });
    const scrollTarget = document.createElement('div');
    scrollTarget.id = 'mirror-e2e-scroll';
    Object.assign(scrollTarget.style, {
      position: 'fixed',
      right: '20px',
      top: 'calc(50% - 80px)',
      width: '120px',
      height: '160px',
      overflow: 'auto',
      background: '#fff',
      zIndex: '2147483647',
    });
    const scrollContent = document.createElement('div');
    scrollContent.style.height = '800px';
    scrollContent.textContent = 'Scroll target';
    scrollTarget.append(scrollContent);
    scrollTarget.addEventListener('click', () => {
      document.body.dataset.mirrorScrollTap = 'yes';
    });
    window.addEventListener(
      'wheel',
      (event) => {
        document.body.dataset.mirrorWheel = JSON.stringify({
          deltaY: event.deltaY,
          target: event.target instanceof Element ? event.target.id : '',
        });
      },
      { capture: true },
    );
    document.body.append(tapTarget, input, scrollTarget);
  });

  const pairingUrl = await waitFor('desktop pairing URL', () =>
    desktop.evaluate(() => window.ccsmMobileRemote?.getPairingUrl()),
  );
  browser = await chromium.launch({ headless: true });
  const phoneContext = await browser.newContext({
    serviceWorkers: 'block',
    viewport: { width: 900, height: 700 },
  });
  if (configuredRelayUrl) {
    await serveLocalMobileAssets(phoneContext, relayUrl);
  }
  const phone = await phoneContext.newPage();
  await phone.goto(pairingUrl);
  await phone.locator('[data-remote-status]').filter({ hasText: 'Connected' }).waitFor();
  await phone.waitForFunction(() => {
    const frame = document.querySelector('#mirror-frame');
    return frame instanceof HTMLImageElement && frame.src.startsWith('data:image/jpeg;base64,');
  });

  const frameBounds = await phone.locator('#mirror-frame').boundingBox();
  assert.ok(frameBounds, 'mirror frame must be visible');

  const tapPoint = await desktop.evaluate(() => {
    const target = document.querySelector('#mirror-e2e-tap');
    const bounds = target?.getBoundingClientRect();
    if (!bounds) return null;
    return {
      x: (bounds.left + bounds.width / 2) / document.documentElement.clientWidth,
      y: (bounds.top + bounds.height / 2) / document.documentElement.clientHeight,
    };
  });
  assert.ok(tapPoint, 'tap target must exist');
  // Guards the regression itself: a center point maps correctly even when the
  // mirrored image box is letterboxed, so this must stay off vertical center.
  assert.ok(
    tapPoint.y < 0.4 || tapPoint.y > 0.6,
    `tap target must be off vertical center to catch letterbox regressions, got y=${tapPoint.y}`,
  );
  // Click where the mirrored pixels are actually painted (object-fit: contain
  // within the frame's box), not just a fraction of the element's own box.
  // If the box does not preserve the source aspect ratio, this diverges from
  // frameBounds-fraction math and exposes the letterbox/crop regression the
  // same way a real finger tapping the visible screen would.
  const paintedRect = await phone.evaluate(() => {
    const frame = document.querySelector('#mirror-frame');
    const box = frame.getBoundingClientRect();
    const scale = Math.min(box.width / frame.naturalWidth, box.height / frame.naturalHeight);
    const paintedWidth = frame.naturalWidth * scale;
    const paintedHeight = frame.naturalHeight * scale;
    return {
      x: box.left + (box.width - paintedWidth) / 2,
      y: box.top + (box.height - paintedHeight) / 2,
      width: paintedWidth,
      height: paintedHeight,
    };
  });
  await phone.mouse.click(
    paintedRect.x + paintedRect.width * tapPoint.x,
    paintedRect.y + paintedRect.height * tapPoint.y,
  );
  await desktop.waitForFunction(() => document.body.dataset.mirrorTap === 'yes');

  await desktop.evaluate(() => {
    document.querySelector('#mirror-e2e-input')?.focus();
  });
  await phone.locator('#text-input').fill('mirror-e2e');
  await phone.locator('#input-send').click();
  await desktop.waitForFunction(
    () => document.querySelector('#mirror-e2e-input')?.value === 'mirror-e2e',
  );
  await phone.locator('[data-key="Enter"]').click();
  await desktop.waitForFunction(() => document.body.dataset.mirrorKey === 'Enter');
  const scrollPoint = await desktop.evaluate(() => {
    const target = document.querySelector('#mirror-e2e-scroll');
    const bounds = target?.getBoundingClientRect();
    if (!bounds) return null;
    return {
      x: (bounds.left + bounds.width / 2) / document.documentElement.clientWidth,
      y: (bounds.top + bounds.height / 2) / document.documentElement.clientHeight,
    };
  });
  assert.ok(scrollPoint, 'scroll target must exist');
  await phone.mouse.click(
    frameBounds.x + frameBounds.width * scrollPoint.x,
    frameBounds.y + frameBounds.height * scrollPoint.y,
  );
  await desktop.waitForFunction(() => document.body.dataset.mirrorScrollTap === 'yes');
  await phone.locator('[data-scroll="360"]').click();
  await desktop.waitForFunction(() => Boolean(document.body.dataset.mirrorWheel));
  try {
    await desktop.waitForFunction(
      () => (document.querySelector('#mirror-e2e-scroll')?.scrollTop ?? 0) > 0,
    );
  } catch (error) {
    const wheel = await desktop.evaluate(() => document.body.dataset.mirrorWheel);
    throw new Error(`scroll target did not move: ${wheel}`, { cause: error });
  }

  console.log(
    `[mobile-remote-relay] PASS real Electron mirror through ${configuredRelayUrl ? 'public' : 'local'} relay`,
  );
}

try {
  await run();
} catch (error) {
  console.error('[mobile-remote-relay] FAIL', error);
  if (wranglerOutput.length > 0) {
    console.error('[mobile-remote-relay] Wrangler tail:\n' + wranglerOutput.slice(-12).join('\n'));
  }
  process.exitCode = 1;
} finally {
  await browser?.close();
  await electronApp?.close();
  await stopExactChild(wrangler);
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  try {
    rmSync(path.join(rootDir, 'cloudflare', '.wrangler'), {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
  } catch {
    // Wrangler can briefly retain cache handles on Windows after its process exits.
  }
}
