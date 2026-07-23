// Desktop-authority proof with a real Electron + PTY fixture.
//
// Pre-req: `npm run build`.
// Run:    node scripts/harness-e2e-mobile-desktop-ownership.mjs
//
// This harness boots the real app in an isolated workspace, drives one live PTY
// session to canonical 132x41, connects a phone page (portrait then landscape)
// through the relay, and proves:
//   1) PTY/headless canonical geometry stays 132x41 across phone viewport
//      changes.
//   2) The phone never emits session.resize.

import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { chromium } from 'playwright';

import {
  rootDir,
  configuredRelayUrl,
  generatePairingIdentity,
  reservePort,
  startWrangler,
  stopExactChild,
  cleanupWranglerLocalState,
  waitFor,
} from './probe-helpers/mobileRemoteHarness.mjs';
import { launchCcsmIsolated } from './probe-utils-real-cli.mjs';

const CANONICAL_COLS = 132;
const CANONICAL_ROWS = 41;
const SID_LABEL = 'ownership-e2e';
const HARNESS_STATE_DIR = path.join(rootDir, '.harness-state', 'mobile-desktop-ownership');
const FAKE_CLAUDE_BIN_DIR = path.join(HARNESS_STATE_DIR, 'fake-claude-bin');
const CLAUDE_CONFIG_DIR = path.join(HARNESS_STATE_DIR, 'claude-config');
const USER_DATA_DIR = path.join(HARNESS_STATE_DIR, 'user-data');

let wrangler = null;
let browser = null;
let context = null;
let electronApp = null;

function log(step) {
  console.log(`[mobile-desktop-ownership] ${step}`);
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function removeDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort cleanup
  }
}

function writeFakeClaudeFixture() {
  ensureDir(FAKE_CLAUDE_BIN_DIR);
  const cmdPath = path.join(FAKE_CLAUDE_BIN_DIR, 'claude.cmd');
  const jsPath = path.join(FAKE_CLAUDE_BIN_DIR, 'fake-claude.js');
  writeFileSync(
    cmdPath,
    [
      '@echo off',
      'setlocal',
      'node "%~dp0fake-claude.js" %*',
      '',
    ].join('\r\n'),
    'utf8',
  );
  writeFileSync(
    jsPath,
    [
      "process.stdout.write('FAKE_CLAUDE_READY\\r\\n');",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => {",
      "  process.stdout.write(`FAKE_ECHO:${chunk}`);",
      '});',
      "process.on('SIGINT', () => process.exit(0));",
      'setInterval(() => {}, 1000);',
      '',
    ].join('\n'),
    'utf8',
  );
}

async function startInstrumentedRemoteController(electron, relayUrl, pairing) {
  return electron.evaluate(
    async (_electron, payload) => {
      const { relayUrlArg, pairingArg } = payload ?? {};
      if (typeof relayUrlArg !== 'string' || relayUrlArg.length === 0) {
        throw new Error(`invalid relay url arg: ${String(relayUrlArg)}`);
      }
      const moduleMod = process.getBuiltinModule?.('node:module');
      const pathMod = process.getBuiltinModule?.('node:path');
      if (!moduleMod?.createRequire || !pathMod?.join) {
        throw new Error('unable to acquire module/path builtins in electron main context');
      }
      const req = moduleMod.createRequire(pathMod.join(process.cwd(), 'package.json'));
      const controllerMod = req(
        pathMod.join(process.cwd(), 'dist', 'electron', 'remote', 'mobileRemoteController.js'),
      );
      const messagesMod = req(pathMod.join(process.cwd(), 'dist', 'electron', 'remote', 'remoteMessages.js'));

      const telemetry = [];
      const pairingStore = {
        _pairing: pairingArg,
        async loadOrCreate() {
          return this._pairing;
        },
        async delete() {
          // no-op for harness fixture
        },
      };

      const controller = await controllerMod.createMobileRemoteController({
        relayUrl: relayUrlArg,
        pairingStore,
        handleMessage: async (peer, raw) => {
          try {
            telemetry.push(JSON.parse(raw));
          } catch {
            // ignore malformed payloads in telemetry capture
          }
          await messagesMod.handleClientMessage(peer, raw);
        },
      });

      globalThis.__ccsmOwnershipRemoteHarness = { controller, telemetry };
      return controller.getPairingUrl();
    },
    { relayUrlArg: relayUrl, pairingArg: pairing },
  );
}

async function stopInstrumentedRemoteController(electron) {
  if (!electron) return;
  await electron
    .evaluate(() => {
      const state = globalThis.__ccsmOwnershipRemoteHarness;
      try {
        state?.controller?.close?.();
      } catch {
        // best effort
      }
      delete globalThis.__ccsmOwnershipRemoteHarness;
    })
    .catch(() => undefined);
}

async function readRemoteTelemetryTypes(electron) {
  return electron.evaluate(() => {
    const state = globalThis.__ccsmOwnershipRemoteHarness;
    const telemetry = Array.isArray(state?.telemetry) ? state.telemetry : [];
    return telemetry.map((message) => message?.type).filter((type) => typeof type === 'string');
  });
}

async function readRemoteHarnessState(electron) {
  return electron.evaluate(() => {
    const state = globalThis.__ccsmOwnershipRemoteHarness;
    return {
      hasController: !!state?.controller,
      status: state?.controller?.getStatus?.() ?? null,
      pairingUrl: state?.controller?.getPairingUrl?.() ?? null,
    };
  });
}

async function readDesktopPtyGeometry(win, sid) {
  return win.evaluate(async (sessionId) => {
    const entries = await window.ccsmPty.list();
    if (!Array.isArray(entries)) return null;
    const entry = entries.find((item) => item?.sid === sessionId);
    if (!entry) return null;
    return {
      cols: entry.cols,
      rows: entry.rows,
      pid: entry.pid ?? null,
    };
  }, sid);
}

async function createAndCanonicalizeDesktopSession(win) {
  return win.evaluate(async ({ label, cols, rows }) => {
    const store = window.__ccsmStore;
    if (!store) throw new Error('__ccsmStore unavailable');

    const cwd = 'C:\\work\\mobile-desktop-ownership';
    store.getState().createSession({ name: `${label}-parking`, cwd });
    const parkingSid = store.getState().activeId;
    if (!parkingSid) throw new Error('failed to create parking session');

    store.getState().createSession({ name: label, cwd });
    const sid = store.getState().activeId;
    if (!sid) throw new Error('failed to create active session');

    const spawnResult = await window.ccsmPty.spawn(sid, cwd);
    if (!spawnResult?.ok) {
      throw new Error(`spawn failed: ${spawnResult?.error ?? 'unknown spawn error'}`);
    }

    await window.ccsmPty.resize(sid, cols, rows);
    store.getState().selectSession(parkingSid);
    await window.ccsmPty.resize(sid, cols, rows);
    await window.ccsmPty.input(sid, 'ownership-fixture-ready\r');
    return { sid, parkingSid };
  }, { label: SID_LABEL, cols: CANONICAL_COLS, rows: CANONICAL_ROWS });
}

function withCcsmTestQuery(pairingUrl) {
  const url = new URL(pairingUrl);
  url.searchParams.set('ccsmTest', '1');
  return url.toString();
}

async function waitForBridge(page) {
  await page.waitForFunction(() => typeof window.__ccsmMobileTest !== 'undefined', undefined, {
    timeout: 15_000,
  });
}

function getSyncState(page) {
  return page.evaluate(() => window.__ccsmMobileTest.getSyncState());
}

async function ensurePhoneSessionSelection(page, sessionName) {
  const topbarName = page.locator('.phone-topbar__name').first();
  const currentName = (await topbarName.textContent())?.trim() ?? '';
  if (currentName === sessionName) return;

  await page.getByRole('button', { name: 'Sessions menu' }).click();
  const sessionRow = page.locator('.ccsm-session-navigator__session-name', {
    hasText: sessionName,
  });
  await sessionRow.first().waitFor({ state: 'visible', timeout: 10_000 });
  await sessionRow.first().click();
  await waitFor(
    `phone selects "${sessionName}"`,
    async () => ((await topbarName.textContent())?.trim() ?? '') === sessionName,
    10_000,
  );

  const closeButton = page.getByRole('button', { name: 'Close' });
  if (await closeButton.isVisible().catch(() => false)) {
    await closeButton.click();
  }
}

async function waitForPhoneGeometry(page, label) {
  await waitFor(
    `${label}: phone installs canonical geometry`,
    async () => {
      const state = await getSyncState(page);
      return (
        state.phase === 'live' &&
        state.geometry?.cols === CANONICAL_COLS &&
        state.geometry?.rows === CANONICAL_ROWS
      );
    },
    20_000,
  );
}

async function assertCanonicalGeometryStable(win, sid, label) {
  const geometry = await readDesktopPtyGeometry(win, sid);
  assert.ok(geometry, `${label}: PTY session must exist`);
  assert.equal(geometry.cols, CANONICAL_COLS, `${label}: PTY cols must remain canonical`);
  assert.equal(geometry.rows, CANONICAL_ROWS, `${label}: PTY rows must remain canonical`);
}

async function main() {
  removeDir(HARNESS_STATE_DIR);
  ensureDir(HARNESS_STATE_DIR);
  writeFakeClaudeFixture();
  ensureDir(CLAUDE_CONFIG_DIR);
  ensureDir(USER_DATA_DIR);
  writeFileSync(path.join(CLAUDE_CONFIG_DIR, 'settings.json'), '{}\n', 'utf8');

  const configuredUrl = configuredRelayUrl();
  let relayUrl = configuredUrl;
  if (!relayUrl) {
    const port = await reservePort();
    const started = await startWrangler(port);
    wrangler = started.child;
    relayUrl = started.relayUrl;
  } else {
    log('using configured public relay');
  }

  const launch = await launchCcsmIsolated({
    tempDir: CLAUDE_CONFIG_DIR,
    userDataDir: USER_DATA_DIR,
    env: {
      PATH: `${FAKE_CLAUDE_BIN_DIR}${path.delimiter}${process.env.PATH ?? ''}`,
      CCSM_MOBILE_REMOTE_RELAY_URL: '',
      DISABLE_AUTOUPDATER: '1',
    },
  });
  electronApp = launch.electronApp;
  const win = launch.win;

  const sessionFixture = await createAndCanonicalizeDesktopSession(win);
  const sid = sessionFixture.sid;
  await waitFor(
    'desktop canonical geometry settles',
    async () => {
      const geometry = await readDesktopPtyGeometry(win, sid);
      return geometry?.cols === CANONICAL_COLS && geometry?.rows === CANONICAL_ROWS;
    },
    20_000,
  );
  await assertCanonicalGeometryStable(win, sid, 'before phone connection');

  const pairing = generatePairingIdentity();
  const pairingUrl = await startInstrumentedRemoteController(electronApp, relayUrl, pairing);
  if (!pairingUrl) {
    const controllerState = await readRemoteHarnessState(electronApp);
    throw new Error(`controller must expose a pairing URL: ${JSON.stringify(controllerState)}`);
  }

  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(String(error?.stack ?? error)));

  await page.goto(withCcsmTestQuery(pairingUrl));
  await waitForBridge(page);
  await waitFor(
    'phone connects',
    async () => (await page.locator('.phone-topbar__connection').first().textContent()) === 'Connected',
    20_000,
  );
  await ensurePhoneSessionSelection(page, SID_LABEL);
  await waitForPhoneGeometry(page, 'portrait');
  await assertCanonicalGeometryStable(win, sid, 'portrait');
  log('PASS portrait connection preserves desktop canonical geometry');

  await page.setViewportSize({ width: 844, height: 390 });
  await waitForPhoneGeometry(page, 'landscape');
  await assertCanonicalGeometryStable(win, sid, 'landscape');
  log('PASS landscape connection preserves desktop canonical geometry');

  const messageTypes = await readRemoteTelemetryTypes(electronApp);
  assert.equal(
    messageTypes.includes('session.resize'),
    false,
    'phone must never emit session.resize (desktop remains authority)',
  );

  assert.deepEqual(consoleErrors, [], 'no browser console errors');
  assert.deepEqual(pageErrors, [], 'no browser page errors');
  console.log('[mobile-desktop-ownership] PASS desktop canonical geometry remains authoritative');
}

try {
  await main();
} catch (error) {
  console.error('[mobile-desktop-ownership] FAIL', error);
  process.exitCode = 1;
} finally {
  await stopInstrumentedRemoteController(electronApp);
  try {
    await electronApp?.close();
  } catch {
    // best effort
  }
  await context?.close().catch(() => undefined);
  await browser?.close();
  await stopExactChild(wrangler);
  cleanupWranglerLocalState();
  removeDir(HARNESS_STATE_DIR);
}

process.exit(process.exitCode ?? 0);
