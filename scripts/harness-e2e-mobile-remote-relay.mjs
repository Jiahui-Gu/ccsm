// End-to-end proof for the Cloudflare mobile relay against the FINAL
// composer/terminal-sync production contract (composer/terminal-sync
// plan, Task 6 Step D). Replaces the earlier hidden-xterm-textarea typing
// with the real Message composer + explicit Send, and adds Ask free-text,
// disconnect/reconnect draft-preservation, and focus-safety coverage on
// top of the original handshake/live-output/recovery/rotation proof.
//
// Pre-req: `npm run build`.
// Run:    node scripts/harness-e2e-mobile-remote-relay.mjs
//
// Supports a public relay via `CCSM_RELAY_URL`; otherwise starts and owns a
// local Wrangler dev server exactly like the deterministic sync harness.

import assert from 'node:assert/strict';

import { chromium } from 'playwright';

import {
  configuredRelayUrl,
  createSimulatedDesktop,
  generatePairingIdentity,
  reservePort,
  startWrangler,
  stopExactChild,
  cleanupWranglerLocalState,
  waitFor,
} from './probe-helpers/mobileRemoteHarness.mjs';

const SID = 'mobile-e2e';

let wrangler = null;
let browser = null;
let desktop = null;
let rotatedDesktop = null;
let context = null;

function log(step) {
  console.log(`[mobile-remote-relay] ${step}`);
}

async function statusText(page) {
  return page.locator('.phone-topbar__connection').first().textContent();
}

async function statusAttr(page) {
  return page.locator('.phone-topbar__connection').first().getAttribute('data-connection');
}

async function activeElementDescriptor(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return 'body';
    return `${el.tagName.toLowerCase()}[aria-label=${el.getAttribute('aria-label')}]`;
  });
}

function composer(page) {
  return page.getByRole('textbox', { name: 'Message' });
}

function sendButton(page) {
  return page.getByRole('button', { name: 'Send' });
}

function terminalKey(page, name) {
  return page.getByRole('button', { name });
}

async function submitViaComposer(page, text) {
  await composer(page).fill(text);
  await sendButton(page).click();
}

async function assertSecurityHeaders(relayUrl) {
  const response = await fetch(new URL('/', relayUrl));
  assert.equal(response.status, 200, 'phone HTML must load before checking security headers');
  assert.match(
    response.headers.get('content-security-policy') ?? '',
    /frame-ancestors\s+'none'/i,
    'phone HTML must deny framing through CSP',
  );
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  await response.body?.cancel();
  log('PASS phone HTML includes Worker security headers');
}

/** Dispatches a real CompositionEvent + native-setter input sequence on
 *  the composer textarea — the same event choreography a real IME
 *  produces against a controlled React input — rather than typing
 *  character-by-character (which does not exercise composition at all). */
async function composeCjkDraft(page, text) {
  await page.evaluate((value) => {
    const el = document.querySelector('textarea[aria-label="Message"]');
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    el.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    el.dispatchEvent(new CompositionEvent('compositionupdate', { data: value }));
    nativeSetter.call(el, value);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertCompositionText' }));
    el.dispatchEvent(new CompositionEvent('compositionend', { data: value }));
  }, text);
}

async function main() {
  const configuredUrl = configuredRelayUrl();
  let relayUrl = configuredUrl;
  if (!relayUrl) {
    const port = await reservePort();
    const started = await startWrangler(port);
    wrangler = started.child;
    relayUrl = started.relayUrl;
  } else {
    log(`using public CCSM_RELAY_URL=${configuredUrl}`);
  }

  await assertSecurityHeaders(relayUrl);

  const pairing = generatePairingIdentity();
  desktop = createSimulatedDesktop(relayUrl, pairing, {
    sessions: [{ sid: SID, cwd: 'C:\\work\\mobile-e2e' }],
  });

  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(String(error?.stack ?? error)));

  await page.goto(`${relayUrl}/#pair=${pairing.roomId}.${pairing.secret}`);

  await waitFor('encrypted desktop/phone handshake', async () => (await statusText(page)) === 'Connected');
  assert.equal(await statusText(page), 'Connected');
  // The drawer is closed by default — `data-session-id` rows only exist
  // once it's open, so the auto-selected session shows up in the top bar
  // instead.
  await page.locator('.phone-topbar__name').filter({ hasText: SID }).waitFor();
  log('PASS encrypted handshake + navigator-driven session selection');

  // --- Focus baseline: nothing has been clicked yet -------------------
  const initialActive = await activeElementDescriptor(page);
  assert.notEqual(initialActive, 'textarea[aria-label=Message]', 'composer must not be focused by default');
  await page.locator('.mobile-terminal').click();
  assert.equal(
    await activeElementDescriptor(page),
    initialActive,
    'clicking the terminal must never move focus (no app focus call, and xterm\'s own internal focus is neutered)',
  );
  log('PASS terminal click never focuses the composer or the xterm helper');

  // --- Composer: a complete draft submission (/status) -----------------
  // Capture the input-relay count BEFORE the Send click so we can prove the
  // composer's acknowledged submission relies solely on `session.submit`
  // (the ordered/awaited PTY write) and never masks/duplicates the
  // submission with a follow-up raw `session.input` (e.g. a synthesized
  // Enter keystroke) once the ack arrives.
  const priorStatusInputCount = desktop.inputs.length;
  await submitViaComposer(page, '/status');
  await waitFor('acknowledged /status submission', () => desktop.submissions.some((s) => s.draft === '/status' && s.ok));
  assert.equal(desktop.submissions.filter((s) => s.draft === '/status').length, 1, '/status must be submitted exactly once');
  await waitFor('composer clears after an acknowledged submission', async () => (await composer(page).inputValue()) === '');
  assert.equal(
    desktop.inputs.length,
    priorStatusInputCount,
    'an acknowledged composer Send must never send a follow-up session.input (e.g. a masking Enter) — session.submit alone must carry the draft+Enter',
  );
  log('PASS composer Send submits a complete /status draft exactly once and clears on ack, with no follow-up session.input');

  // --- CJK composition: one complete draft, one wire submission --------
  await composeCjkDraft(page, '你好世界');
  assert.equal(await composer(page).inputValue(), '你好世界', 'composition must land as one complete draft');
  await sendButton(page).click();
  await waitFor('acknowledged CJK submission', () => desktop.submissions.some((s) => s.draft === '你好世界' && s.ok));
  assert.equal(
    desktop.submissions.filter((s) => s.draft === '你好世界').length,
    1,
    'a CJK composition must reach the desktop as exactly one complete draft submission',
  );
  log('PASS CJK composition is sent once as a complete draft');

  // --- Return stays a local newline until Send --------------------------
  await composer(page).click();
  await composer(page).fill(''); // fresh
  await page.keyboard.type('first line');
  await page.keyboard.press('Enter');
  await page.keyboard.type('second line');
  assert.equal(await composer(page).inputValue(), 'first line\nsecond line');
  assert.equal(
    desktop.submissions.some((s) => s.draft.includes('first line')),
    false,
    'Return must never submit — only Send does',
  );
  await sendButton(page).click();
  await waitFor('multiline submission acknowledged', () =>
    desktop.submissions.some((s) => s.draft === 'first line\nsecond line' && s.ok),
  );
  log('PASS Return inserts a local newline; only Send submits the multiline draft');

  // --- A rejected submission preserves the draft and shows role=alert ---
  desktop.setSubmitHandler((sid, requestId, draft) => {
    if (draft === 'please reject me') return { ok: false, error: 'session_not_found' };
    if (!sid || !requestId || !draft) return { ok: false, error: 'invalid_submission' };
    return { ok: true };
  });
  await submitViaComposer(page, 'please reject me');
  await page.getByRole('alert').waitFor();
  assert.equal(await composer(page).inputValue(), 'please reject me', 'a rejected submission must preserve the draft');
  assert.equal(await sendButton(page).isEnabled(), true, 'Send must re-enable after a rejected submission (not stuck pending)');
  // Restore acceptance and retry the SAME (still-present) draft.
  desktop.setSubmitHandler(undefined);
  await sendButton(page).click();
  await waitFor('the retried draft is eventually acknowledged', () =>
    desktop.submissions.some((s) => s.draft === 'please reject me' && s.ok),
  );
  await waitFor('composer clears once the retry is acknowledged', async () => (await composer(page).inputValue()) === '');
  log('PASS a rejected submission preserves the draft with a visible alert; a later matching ack clears it');

  // --- Simulated AskUserQuestion: native PTY UI, discrete keys, free text
  const priorInputCount = desktop.inputs.length;
  desktop.sendPty(
    SID,
    1,
    '\r\n? AskUserQuestion: choose an approach\r\n  1. Approach A\r\n> 2. Approach B\r\n  3. Approach C\r\n  4. Type something else\r\n',
  );
  await page.locator('.xterm-rows').filter({ hasText: 'AskUserQuestion' }).waitFor();
  await terminalKey(page, '2').click();
  await terminalKey(page, 'Enter').click();
  await waitFor('both discrete Ask keys reach the desktop', () => desktop.inputs.length >= priorInputCount + 2);
  const askControlBytes = desktop.inputs.slice(priorInputCount).map((entry) => entry.data);
  assert.deepEqual(askControlBytes, ['2', '\r'], 'Ask selection must send exactly the discrete key bytes, in order');
  await submitViaComposer(page, 'extra detail for approach B');
  await waitFor('Ask free-text draft acknowledged', () =>
    desktop.submissions.some((s) => s.draft === 'extra detail for approach B' && s.ok),
  );
  log('PASS simulated Ask: discrete keys (exact control bytes) + composer free text traverse together');

  // --- Focus safety: explicit user focus survives output/terminal clicks
  await composer(page).click();
  assert.equal(await activeElementDescriptor(page), 'textarea[aria-label=Message]');
  await page.locator('.mobile-terminal').click();
  assert.equal(
    await activeElementDescriptor(page),
    'textarea[aria-label=Message]',
    'clicking the terminal after the user focused the composer must not steal focus away (xterm\'s own mousedown focus is neutered)',
  );
  desktop.sendPty(SID, 2, 'unsolicited-live-output\r\n');
  await page.locator('.xterm-rows').filter({ hasText: 'unsolicited-live-output' }).waitFor();
  assert.equal(
    await activeElementDescriptor(page),
    'textarea[aria-label=Message]',
    'receiving live PTY output must never blur the composer',
  );
  log('PASS terminal clicks and live output never move focus away from a user-focused composer');

  // --- Disconnect: Send/keys disabled, draft preserved, no auto-submit --
  // Closes the encrypted desktop peer only (never the relay process
  // itself): the relay Durable Object proactively closes the phone's own
  // socket too once its sole desktop peer disconnects (no role successor
  // yet present), which is exactly what a real transient network drop
  // looks like from the phone's side — and unlike restarting the whole
  // Wrangler dev server, it can never race the OS's own port-rebind
  // timing, and it works identically for both the local-Wrangler and
  // public-relay (`CCSM_RELAY_URL`) code paths.
  await composer(page).fill('kept across disconnect');
  desktop.close();
  desktop = null;
  await waitFor('phone network interruption', async () => (await statusAttr(page)) === 'reconnecting');
  await waitFor('Send disables while disconnected', async () => await sendButton(page).isDisabled());
  assert.equal(await terminalKey(page, 'Enter').isDisabled(), true, 'terminal keys must disable while disconnected too');
  assert.equal(await composer(page).inputValue(), 'kept across disconnect', 'the draft must survive a disconnect untouched');
  log('PASS disconnect disables Send/keys and preserves the existing draft');

  desktop = createSimulatedDesktop(relayUrl, pairing, { sessions: [{ sid: SID, cwd: 'C:\\work\\mobile-e2e' }] });
  await waitFor(
    'encrypted phone reconnection',
    async () => (await statusText(page)) === 'Connected' && desktop.authenticatedCount >= 1,
    30_000,
  );
  assert.equal(await composer(page).inputValue(), 'kept across disconnect', 'reconnect must never auto-submit the preserved draft');
  assert.equal(
    desktop.submissions.some((s) => s.draft === 'kept across disconnect'),
    false,
    'reconnect must never auto-submit the preserved draft',
  );
  await waitFor('Send re-enables once reconnected', async () => await sendButton(page).isEnabled());
  await sendButton(page).click();
  await waitFor('the preserved draft submits once explicitly sent', () =>
    desktop.submissions.some((s) => s.draft === 'kept across disconnect' && s.ok),
  );
  log('PASS reconnect never auto-submits; explicit Send afterward works');

  // --- Live output + duplicate dedupe -----------------------------------
  desktop.sendPty(SID, 40, 'live-after-reconnect\r\n');
  await page.locator('.xterm-rows').filter({ hasText: 'live-after-reconnect' }).waitFor();
  desktop.sendPty(SID, 40, 'DUPLICATE-MUST-NOT-RENDER');
  desktop.sendPty(SID, 41, 'recovered-live\r\n');
  await page.locator('.xterm-rows').filter({ hasText: 'recovered-live' }).waitFor();
  assert.doesNotMatch((await page.locator('.xterm-rows').textContent()) ?? '', /DUPLICATE-MUST-NOT-RENDER/);
  log('PASS live output renders and a duplicate seq is deduplicated');

  // --- Old-secret rejection after rotation ------------------------------
  desktop.close();
  desktop = null;
  const rotatedPairing = { roomId: pairing.roomId, secret: generatePairingIdentity().secret };
  rotatedDesktop = createSimulatedDesktop(relayUrl, rotatedPairing, { sessions: [{ sid: SID, cwd: 'C:\\work\\mobile-e2e' }] });
  await waitFor(
    'old credential rejection after rotation',
    async () => (await statusAttr(page)) === 'authentication_failed',
    30_000,
  );
  log('PASS old pairing secret is rejected after rotation');

  assert.deepEqual(consoleErrors, [], 'no browser console errors across the whole run');
  assert.deepEqual(pageErrors, [], 'no browser pageerror events across the whole run');

  console.log('[mobile-remote-relay] PASS composer, controls, Ask, recovery, re-pair');
}

try {
  await main();
} catch (error) {
  console.error('[mobile-remote-relay] FAIL', error);
  process.exitCode = 1;
} finally {
  rotatedDesktop?.close();
  desktop?.close();
  await context?.close().catch(() => undefined);
  await browser?.close();
  await stopExactChild(wrangler);
  cleanupWranglerLocalState();
}

// Playwright/Chromium (and, transitively, Wrangler's own dependency tree)
// can leave a handle open that keeps Node's event loop alive even after
// every resource this harness owns has been explicitly closed above and
// every assertion has already run to completion — exit codes are already
// finalized by this point, so force the exit rather than hang forever.
process.exit(process.exitCode ?? 0);
