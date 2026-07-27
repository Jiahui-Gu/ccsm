// Real Electron -> encrypted relay -> phone browser mirror proof.
//
// Local:  node scripts/harness-e2e-mobile-remote-relay.mjs
// Public: CCSM_RELAY_URL=https://<worker>.workers.dev node scripts/harness-e2e-mobile-remote-relay.mjs

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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
    Object.assign(tapTarget.style, {
      position: 'fixed',
      left: 'calc(50% - 100px)',
      top: 'calc(50% - 60px)',
      width: '200px',
      height: '120px',
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
    window.addEventListener(
      'wheel',
      (event) => {
        document.body.dataset.mirrorScroll = String(event.deltaY);
      },
      { once: true },
    );
    document.body.append(tapTarget, input);
  });

  const pairingUrl = await waitFor('desktop pairing URL', () =>
    desktop.evaluate(() => window.ccsmMobileRemote?.getPairingUrl()),
  );
  browser = await chromium.launch({ headless: true });
  const phone = await browser.newPage();
  await phone.goto(pairingUrl);
  await phone.locator('[data-remote-status]').filter({ hasText: 'Connected' }).waitFor();
  await phone.waitForFunction(() => {
    const frame = document.querySelector('#mirror-frame');
    return frame instanceof HTMLImageElement && frame.src.startsWith('data:image/jpeg;base64,');
  });

  const frameBounds = await phone.locator('#mirror-frame').boundingBox();
  assert.ok(frameBounds, 'mirror frame must be visible');
  await phone.mouse.click(
    frameBounds.x + frameBounds.width / 2,
    frameBounds.y + frameBounds.height / 2,
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
  await phone.locator('[data-scroll="360"]').click();
  await desktop.waitForFunction(() => Boolean(document.body.dataset.mirrorScroll));
  const scrollDelta = await desktop.evaluate(() => document.body.dataset.mirrorScroll);
  assert.equal(Math.abs(Number(scrollDelta)), 360);

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
