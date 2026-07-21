// End-to-end proof for the Cloudflare mobile relay.
//
// Pre-req: `npm run build`.
// Run:    node scripts/harness-e2e-mobile-remote-relay.mjs

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { createEncryptedPeer } = require(
  path.join(rootDir, 'dist', 'electron', 'remote', 'encryptedPeer.js'),
);
const { createRelaySocket } = require(
  path.join(rootDir, 'dist', 'electron', 'remote', 'relaySocket.js'),
);
const { generatePairingIdentity } = require(
  path.join(rootDir, 'dist', 'src', 'shared', 'mobileRemote', 'index.js'),
);

const wranglerOutput = [];
let wrangler = null;
let browser = null;
let desktop = null;
let rotatedDesktop = null;

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

async function waitFor(description, predicate, timeout = 20_000) {
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
    if (wranglerOutput.length > 100) wranglerOutput.shift();
  }
}

async function startWrangler(port) {
  const wranglerBin = path.join(rootDir, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  const child = spawn(
    process.execPath,
    [
      wranglerBin,
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
      detached: false,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  wrangler = child;
  child.stdout.on('data', recordWranglerOutput);
  child.stderr.on('data', recordWranglerOutput);
  child.once('exit', (code) => {
    if (code && code !== 0) {
      wranglerOutput.push(`wrangler exited with code ${code}`);
    }
  });

  const relayUrl = `http://127.0.0.1:${port}`;
  await waitFor('Wrangler dev server', async () => {
    if (child.exitCode !== null) {
      throw new Error(wranglerOutput.slice(-12).join('\n'));
    }
    const response = await fetch(relayUrl);
    return response.ok;
  }, 30_000);
  return { child, relayUrl };
}

function createSimulatedDesktop(relayUrl, pairing, snapshotState) {
  const socket = createRelaySocket({
    relayUrl,
    roomId: pairing.roomId,
    heartbeatMs: 2_000,
    random: () => 0,
  });
  const inputs = [];
  let pendingInput = '';
  let authenticatedCount = 0;
  const failures = [];
  const peer = createEncryptedPeer({
    pairing,
    socket,
    async handleMessage(remotePeer, raw) {
      const message = JSON.parse(raw);
      if (message.type === 'sessions.list') {
        remotePeer.send({
          type: 'sessions.list',
          sessions: [{ sid: 'mobile-e2e', cwd: 'C:\\work\\mobile-e2e', cols: 80, rows: 24 }],
        });
      } else if (message.type === 'session.snapshot' && message.sid === 'mobile-e2e') {
        remotePeer.subscribedSid = message.sid;
        remotePeer.send({
          type: 'session.snapshot',
          sid: message.sid,
          seq: snapshotState.seq,
          data: snapshotState.data,
          cols: 80,
          rows: 24,
        });
      } else if (message.type === 'session.input' && message.sid === 'mobile-e2e') {
        pendingInput += message.data;
        if (pendingInput.includes('\r')) {
          inputs.push(pendingInput);
          pendingInput = '';
        }
      }
    },
    onAuthenticated() {
      authenticatedCount += 1;
    },
    onFailure(failure) {
      failures.push(failure);
    },
  });
  peer.start();

  return {
    inputs,
    failures,
    peer,
    get authenticatedCount() {
      return authenticatedCount;
    },
    sendPty(seq, chunk) {
      peer.send({ type: 'pty.data', sid: 'mobile-e2e', seq, chunk });
    },
    close() {
      peer.close();
    },
  };
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
  if (child.exitCode === null) {
    try {
      process.kill(child.pid, 'SIGKILL');
    } catch {
      // It exited between the state check and signal.
    }
  }
}

async function main() {
  const configuredRelayUrl = process.env.CCSM_RELAY_URL?.replace(/\/+$/, '');
  let relayUrl = configuredRelayUrl;
  let port = null;
  if (!relayUrl) {
    port = await reservePort();
    const started = await startWrangler(port);
    wrangler = started.child;
    relayUrl = started.relayUrl;
  }
  const pairing = generatePairingIdentity();
  const snapshotState = { seq: 7, data: 'snapshot-ready\r\n' };
  desktop = createSimulatedDesktop(relayUrl, pairing, snapshotState);

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const phone = await context.newPage();
  const phoneFrames = [];
  phone.on('websocket', (webSocket) => {
    const socketNumber = phoneFrames.filter((entry) => entry.event === 'open').length + 1;
    phoneFrames.push({ event: 'open', socketNumber });
    webSocket.on('framesent', ({ payload }) => {
      try {
        phoneFrames.push({ event: 'sent', socketNumber, type: JSON.parse(String(payload)).type });
      } catch {
        phoneFrames.push({ event: 'sent', socketNumber, type: 'invalid' });
      }
    });
    webSocket.on('framereceived', ({ payload }) => {
      try {
        phoneFrames.push({ event: 'received', socketNumber, type: JSON.parse(String(payload)).type });
      } catch {
        phoneFrames.push({ event: 'received', socketNumber, type: 'invalid' });
      }
    });
    webSocket.on('close', () => phoneFrames.push({ event: 'close', socketNumber }));
  });
  await phone.goto(`${relayUrl}/#pair=${pairing.roomId}.${pairing.secret}`);

  const status = phone.locator('[data-remote-status]');
  await waitFor(
    'encrypted desktop/phone handshake',
    async () => (await status.textContent()) === 'Connected',
  );
  assert.equal(await status.textContent(), 'Connected');
  await phone.locator('#sessions button').filter({ hasText: 'mobile-e2e' }).waitFor();
  await phone.locator('.xterm-rows').filter({ hasText: 'snapshot-ready' }).waitFor();
  assert.match(await phone.locator('.xterm-rows').textContent(), /snapshot-ready/);
  await phone.evaluate(() => {
    window.__remoteStatusHistory = [];
    const statusElement = document.querySelector('[data-remote-status]');
    new MutationObserver(() => {
      window.__remoteStatusHistory.push({
        status: statusElement?.getAttribute('data-status'),
        text: statusElement?.textContent,
      });
    }).observe(statusElement, { attributes: true, childList: true, subtree: true });
  });

  await phone.locator('.xterm-helper-textarea').focus();
  await phone.keyboard.type('echo mobile-e2e');
  await phone.keyboard.press('Enter');
  await waitFor(
    'typed command at the simulated PTY input seam',
    () => desktop.inputs.length === 1,
  );
  assert.deepEqual(desktop.inputs, ['echo mobile-e2e\r']);

  desktop.sendPty(8, 'live-output\r\n');
  await phone.locator('.xterm-rows').filter({ hasText: 'live-output' }).waitFor();

  if (configuredRelayUrl) {
    desktop.close();
    desktop = null;
  } else {
    await stopExactChild(wrangler);
    wrangler = null;
  }
  await waitFor(
    'phone network interruption',
    async () => (await status.getAttribute('data-status')) === 'reconnecting',
  );
  snapshotState.seq = 20;
  snapshotState.data = 'snapshot-ready\r\nrecovered-snapshot\r\n';
  if (configuredRelayUrl) {
    desktop = createSimulatedDesktop(relayUrl, pairing, snapshotState);
  } else {
    const restarted = await startWrangler(port);
    wrangler = restarted.child;
  }
  try {
    await waitFor(
      'encrypted phone reconnection',
      async () =>
        (await status.textContent()) === 'Connected' &&
        desktop.authenticatedCount >= (configuredRelayUrl ? 1 : 2),
      30_000,
    );
  } catch (error) {
    throw new Error(
      `${error.message}; phone=${await status.textContent()} desktopAuth=${desktop.authenticatedCount} desktopFailures=${desktop.failures.join(',')} phoneStatuses=${JSON.stringify(await phone.evaluate(() => window.__remoteStatusHistory))} phoneFrames=${JSON.stringify(phoneFrames)}`,
    );
  }
  await phone.locator('.xterm-rows').filter({ hasText: 'recovered-snapshot' }).waitFor();
  desktop.sendPty(20, 'DUPLICATE-MUST-NOT-RENDER');
  desktop.sendPty(21, 'recovered-live\r\n');
  await phone.locator('.xterm-rows').filter({ hasText: 'recovered-live' }).waitFor();
  assert.doesNotMatch(
    (await phone.locator('.xterm-rows').textContent()) ?? '',
    /DUPLICATE-MUST-NOT-RENDER/,
  );

  desktop.close();
  desktop = null;
  const rotatedPairing = { roomId: pairing.roomId, secret: generatePairingIdentity().secret };
  rotatedDesktop = createSimulatedDesktop(relayUrl, rotatedPairing, snapshotState);
  const oldCredentialReconnectResult = await waitFor(
    'old credential rejection after rotation',
    async () => {
      const value = await status.getAttribute('data-status');
      return value === 'authentication_failed' ? value.replace('_', '-') : false;
    },
    30_000,
  );
  assert.equal(oldCredentialReconnectResult, 'authentication-failed');

  console.log('[mobile-remote-relay] PASS encrypted relay, PTY, recovery, dedupe, rotation');
}

try {
  await main();
} catch (error) {
  console.error('[mobile-remote-relay] FAIL', error);
  if (wranglerOutput.length > 0) {
    console.error('[mobile-remote-relay] Wrangler tail:\n' + wranglerOutput.slice(-12).join('\n'));
  }
  process.exitCode = 1;
} finally {
  rotatedDesktop?.close();
  desktop?.close();
  await browser?.close();
  await stopExactChild(wrangler);
  rmSync(path.join(rootDir, 'cloudflare', '.wrangler'), { recursive: true, force: true });
}
