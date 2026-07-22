// Deterministic buffer-parity + fault-injection dogfood for the mobile
// remote terminal sync pipeline (composer/terminal-sync plan, Task 6).
//
// Pre-req: `npm run build`.
// Run:    node scripts/harness-e2e-mobile-terminal-sync.mjs
//
// For each of 5 independent fault-injection cases, this harness:
//   1. starts (or reuses, via CCSM_RELAY_URL) a local Wrangler relay and an
//      encrypted simulated desktop peer speaking the real wire protocol;
//   2. opens the REAL built phone PWA in Playwright at
//      `?ccsmTest=1#pair=...` (never a page-injected reducer call — every
//      PTY byte and snapshot travels as a real encrypted wire message);
//   3. learns the browser's own negotiated terminal dimensions from its
//      first `session.resize`, THEN builds an authoritative
//      `@xterm/headless` + `@xterm/addon-serialize` terminal at those exact
//      dimensions;
//   4. feeds the deterministic fixture (`scripts/fixtures/
//      mobile-remote-pty-fixture.mjs`) to that authoritative terminal in
//      perfect order (the "ground truth PTY"), while deliberately
//      perturbing what actually goes out over the wire to the phone
//      (duplicated, stale, gapped, disconnected, or sent for the wrong
//      session id);
//   5. waits for the phone's test bridge to report the sync reducer back
//      at `phase: 'live'`, then polls `serializeTerminal()` until the
//      browser's real `SerializeAddon.serialize()` output exactly equals
//      the authoritative terminal's — no substring/plain-text shortcuts.

import assert from 'node:assert/strict';

import { chromium } from 'playwright';
import headlessPkg from '@xterm/headless';
import serializeAddonPkg from '@xterm/addon-serialize';

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
import {
  FIXTURE_ALT_SCREEN_MARKER,
  FIXTURE_ERASED_MARKERS,
  FIXTURE_SURVIVING_MARKERS,
  fixtureLineMarker,
  sequencedFixture,
} from './fixtures/mobile-remote-pty-fixture.mjs';

const { Terminal: HeadlessTerminal } = headlessPkg;
const { SerializeAddon } = serializeAddonPkg;

const SID = 'sync-e2e';
const SID_B = 'sync-e2e-b';
const FIXTURE = sequencedFixture(1); // [{ seq: 1..127, chunk }] — shared, immutable across cases.
const FINAL_SEQ = FIXTURE[FIXTURE.length - 1].seq;

let wrangler = null;
let browser = null;
const openHandles = new Set(); // tracks {context} objects so a thrown case still gets cleaned up centrally.

// ---------------------------------------------------------------------------
// Authoritative reference terminal
// ---------------------------------------------------------------------------

function createReferenceTerminal(cols, rows) {
  const terminal = new HeadlessTerminal({
    cols,
    rows,
    scrollback: 5000,
    convertEol: false,
    allowProposedApi: true,
  });
  const serializeAddon = new SerializeAddon();
  terminal.loadAddon(serializeAddon);
  return {
    write(data) {
      return new Promise((resolve) => terminal.write(data, resolve));
    },
    serialize() {
      return serializeAddon.serialize();
    },
    dispose() {
      terminal.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// Phone page + bridge helpers
// ---------------------------------------------------------------------------

async function openPhonePage(relayUrl, pairing) {
  // A phone-representative viewport — functionally the fixture/reducer are
  // dimension-independent (verified separately), but this keeps the
  // harness honest about what it's actually proving parity for.
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  openHandles.add(context);
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(String(error?.stack ?? error)));
  await page.goto(`${relayUrl}/?ccsmTest=1#pair=${pairing.roomId}.${pairing.secret}`);
  return {
    page,
    consoleErrors,
    pageErrors,
    async close() {
      openHandles.delete(context);
      await context.close();
    },
  };
}

async function waitForBridge(page) {
  await page.waitForFunction(() => typeof window.__ccsmMobileTest !== 'undefined', undefined, {
    timeout: 15_000,
  });
}

function getSyncState(page) {
  return page.evaluate(() => window.__ccsmMobileTest.getSyncState());
}

function serializeTerminal(page) {
  return page.evaluate(() => window.__ccsmMobileTest.serializeTerminal());
}

async function waitForSyncState(page, description, predicate, timeout = 20_000) {
  return waitFor(
    description,
    async () => {
      const state = await getSyncState(page);
      return predicate(state) ? state : false;
    },
    timeout,
  );
}

async function waitForExactSerialize(page, expected, timeout = 15_000) {
  let last = null;
  await waitFor(
    'browser SerializeAddon.serialize() to equal the authoritative buffer',
    async () => {
      last = await serializeTerminal(page);
      return last === expected;
    },
    timeout,
  ).catch((error) => {
    throw new Error(`${error.message}\n--- last actual (${last?.length ?? 0} chars) ---\n${last}`);
  });
  return last;
}

async function waitForNewResize(desktop, sinceCount, timeout = 15_000) {
  await waitFor('phone session.resize reflecting real browser dimensions', () => desktop.resizes.length > sinceCount, timeout);
  const resize = desktop.resizes[desktop.resizes.length - 1];
  return { cols: resize.cols, rows: resize.rows };
}

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

// ---------------------------------------------------------------------------
// Shared final-parity assertion
// ---------------------------------------------------------------------------

async function assertExactParity(label, page, expectedSerialize, extraAbsentMarkers = []) {
  const actual = await waitForExactSerialize(page, expectedSerialize);
  assert.equal(actual, expectedSerialize, `${label}: exact buffer parity`);

  for (const marker of FIXTURE_SURVIVING_MARKERS) {
    const count = countOccurrences(actual, marker);
    assert.equal(count, 1, `${label}: marker "${marker}" must appear exactly once (got ${count})`);
  }
  for (const marker of FIXTURE_ERASED_MARKERS) {
    assert.equal(actual.includes(marker), false, `${label}: erased marker "${marker}" must be absent`);
  }
  assert.equal(
    actual.includes(FIXTURE_ALT_SCREEN_MARKER),
    false,
    `${label}: alternate-screen-only marker must be absent from the normal buffer`,
  );
  for (const marker of extraAbsentMarkers) {
    assert.equal(actual.includes(marker), false, `${label}: poison/stale marker "${marker}" must be absent`);
  }

  const state = await getSyncState(page);
  assert.equal(state.phase, 'live', `${label}: sync phase must return to live`);
  assert.equal(state.lastSeq, FINAL_SEQ, `${label}: lastSeq must reach the final fixture seq`);
}

function assertNoBrowserErrors(label, handle) {
  assert.deepEqual(handle.consoleErrors, [], `${label}: no browser console errors`);
  assert.deepEqual(handle.pageErrors, [], `${label}: no browser pageerror events`);
}

// ---------------------------------------------------------------------------
// Case 1: duplicate + stale
// ---------------------------------------------------------------------------

async function caseDuplicateAndStale(relayUrl) {
  const label = 'duplicate-and-stale';
  const pairing = generatePairingIdentity();
  const desktop = createSimulatedDesktop(relayUrl, pairing, {
    sessions: [{ sid: SID, cwd: 'C:\\work\\sync-e2e' }],
  });
  const handle = await openPhonePage(relayUrl, pairing);
  try {
    await waitForBridge(handle.page);
    await waitFor(`${label}: initial session.snapshot request`, () => desktop.snapshotRequests.length >= 1, 15_000);
    const dims = await waitForNewResize(desktop, 0);
    const reference = createReferenceTerminal(dims.cols, dims.rows);
    let referenceSeq = 0;
    desktop.setSnapshotProvider(SID, () => ({ seq: referenceSeq, data: reference.serialize() }));

    const DUPLICATE_SEQ = 60; // comfortably inside the "safe, exactly-once" numbered-line range.
    for (const { seq, chunk } of FIXTURE) {
      await reference.write(chunk);
      referenceSeq = seq;
      desktop.sendRawPty(SID, seq, chunk);
      if (seq === DUPLICATE_SEQ) {
        // Re-send the SAME seq with deliberately different ("poisoned")
        // text — its absence is unambiguous, unlike re-sending the exact
        // original bytes (which would be indistinguishable from a correct
        // no-op on a lossless-duplicate check alone).
        desktop.sendRawPty(SID, DUPLICATE_SEQ, 'POISON-DUPLICATE-MUST-NOT-APPEAR\r\n');
        // Stale: an older seq re-arriving after the fact.
        desktop.sendRawPty(SID, DUPLICATE_SEQ - 1, 'POISON-STALE-MUST-NOT-APPEAR\r\n');
      }
    }

    await assertExactParity(label, handle.page, reference.serialize(), [
      'POISON-DUPLICATE-MUST-NOT-APPEAR',
      'POISON-STALE-MUST-NOT-APPEAR',
    ]);
    assert.equal(
      desktop.snapshotRequests.length,
      1,
      `${label}: a duplicate/stale chunk must never trigger a snapshot request (only the initial selection request)`,
    );
    assertNoBrowserErrors(label, handle);
    reference.dispose();
  } finally {
    await handle.close();
    desktop.close();
  }
}

// ---------------------------------------------------------------------------
// Case 2: snapshot / live overlap
// ---------------------------------------------------------------------------

async function caseSnapshotLiveOverlap(relayUrl) {
  const label = 'snapshot-live-overlap';
  const pairing = generatePairingIdentity();
  const desktop = createSimulatedDesktop(relayUrl, pairing, {
    sessions: [{ sid: SID, cwd: 'C:\\work\\sync-e2e' }],
  });
  const handle = await openPhonePage(relayUrl, pairing);
  try {
    await waitForBridge(handle.page);
    await waitFor(`${label}: initial session.snapshot request`, () => desktop.snapshotRequests.length >= 1, 15_000);
    const dims = await waitForNewResize(desktop, 0);
    const reference = createReferenceTerminal(dims.cols, dims.rows);
    let referenceSeq = 0;
    // Every snapshot request for this session is now answered entirely
    // manually via `sendSnapshotNow` below — returning `null` here means
    // the desktop's automatic responder must never race ahead and answer
    // the gap-recovery request the instant it arrives, which is exactly
    // what "deliberately delay the snapshot response" requires.
    desktop.setSnapshotProvider(SID, () => null);
    let snapshotAnswer = null; // frozen once, "through N" (N = GAP_AT), below.

    const GAP_AT = 51; // never sent on the wire — the missing chunk.
    const BUFFERED_TAIL = [GAP_AT + 1, GAP_AT + 2]; // both actually sent, both must be buffered.
    const upToGap = FIXTURE.filter((entry) => entry.seq < GAP_AT);
    const gapChunk = FIXTURE.find((entry) => entry.seq === GAP_AT);
    const bufferedChunks = FIXTURE.filter((entry) => BUFFERED_TAIL.includes(entry.seq));
    const rest = FIXTURE.filter((entry) => entry.seq > BUFFERED_TAIL[BUFFERED_TAIL.length - 1]);

    for (const { seq, chunk } of upToGap) {
      await reference.write(chunk);
      referenceSeq = seq;
      desktop.sendRawPty(SID, seq, chunk);
    }
    await waitForSyncState(handle.page, `${label}: live before the gap`, (s) => s.phase === 'live' && s.lastSeq === GAP_AT - 1);

    // Advance the reference through the gap seq ITSELF (but never send it
    // on the wire) and freeze a snapshot answer "through N" (N = GAP_AT)
    // right now, before anything below is written — deliberately older
    // than the chunks about to arrive, which is the whole point of the
    // overlap.
    await reference.write(gapChunk.chunk);
    referenceSeq = GAP_AT;
    snapshotAnswer = { seq: GAP_AT, data: reference.serialize() };

    // Both of these DO reach the wire while that frozen snapshot answer is
    // still being withheld — the client must buffer both rather than
    // write or discard them.
    for (const { seq, chunk } of bufferedChunks) {
      await reference.write(chunk);
      referenceSeq = seq;
      desktop.sendRawPty(SID, seq, chunk);
    }

    const overlapping = await waitForSyncState(
      handle.page,
      `${label}: buffered tail present while the snapshot is withheld`,
      (s) => s.phase === 'syncing' && s.snapshotRequested === true && s.bufferedSeqs.length >= BUFFERED_TAIL.length,
    );
    assert.deepEqual(
      [...overlapping.bufferedSeqs].sort((a, b) => a - b),
      BUFFERED_TAIL,
      `${label}: both post-gap chunks must be buffered during the overlap window`,
    );

    // Deliberate delay before finally answering — the overlap window.
    await new Promise((resolve) => setTimeout(resolve, 300));
    desktop.sendSnapshotNow(SID, snapshotAnswer.seq, snapshotAnswer.data, dims.cols, dims.rows);

    for (const { seq, chunk } of rest) {
      await reference.write(chunk);
      referenceSeq = seq;
      desktop.sendRawPty(SID, seq, chunk);
    }

    await assertExactParity(label, handle.page, reference.serialize());
    assert.equal(
      desktop.snapshotRequests.length,
      2,
      `${label}: exactly one snapshot request for this one gap (plus the initial selection request)`,
    );
    assertNoBrowserErrors(label, handle);
    reference.dispose();
  } finally {
    await handle.close();
    desktop.close();
  }
}

// ---------------------------------------------------------------------------
// Case 3: gap recovery (clean, immediate — answers exactly one request)
// ---------------------------------------------------------------------------

async function caseGapRecovery(relayUrl) {
  const label = 'gap-recovery';
  const pairing = generatePairingIdentity();
  const desktop = createSimulatedDesktop(relayUrl, pairing, {
    sessions: [{ sid: SID, cwd: 'C:\\work\\sync-e2e' }],
  });
  const handle = await openPhonePage(relayUrl, pairing);
  try {
    await waitForBridge(handle.page);
    await waitFor(`${label}: initial session.snapshot request`, () => desktop.snapshotRequests.length >= 1, 15_000);
    const dims = await waitForNewResize(desktop, 0);
    const reference = createReferenceTerminal(dims.cols, dims.rows);
    let referenceSeq = 0;
    desktop.setSnapshotProvider(SID, () => ({ seq: referenceSeq, data: reference.serialize() }));

    const OMITTED_SEQ = 71; // N+1 — never sent on the wire.
    for (const { seq, chunk } of FIXTURE) {
      await reference.write(chunk);
      referenceSeq = seq;
      if (seq === OMITTED_SEQ) continue; // the gap.
      desktop.sendRawPty(SID, seq, chunk); // N+2 (and everything else) is sent normally.
    }

    await assertExactParity(label, handle.page, reference.serialize());
    assert.equal(
      desktop.snapshotRequests.length,
      2,
      `${label}: exactly one snapshot request answers this one gap (plus the initial selection request)`,
    );
    assertNoBrowserErrors(label, handle);
    reference.dispose();
  } finally {
    await handle.close();
    desktop.close();
  }
}

// ---------------------------------------------------------------------------
// Case 4: disconnect during a burst, reconnect, snapshot, drain the tail
// ---------------------------------------------------------------------------

async function caseDisconnectDuringBurst(relayUrl) {
  const label = 'disconnect-during-burst';
  const pairing = generatePairingIdentity();
  let desktop = createSimulatedDesktop(relayUrl, pairing, {
    sessions: [{ sid: SID, cwd: 'C:\\work\\sync-e2e' }],
  });
  const handle = await openPhonePage(relayUrl, pairing);
  try {
    await waitForBridge(handle.page);
    await waitFor(`${label}: initial session.snapshot request`, () => desktop.snapshotRequests.length >= 1, 15_000);
    const dims = await waitForNewResize(desktop, 0);
    const reference = createReferenceTerminal(dims.cols, dims.rows);
    let referenceSeq = 0;
    desktop.setSnapshotProvider(SID, () => ({ seq: referenceSeq, data: reference.serialize() }));

    const DISCONNECT_AFTER = 40;
    const beforeDisconnect = FIXTURE.filter((entry) => entry.seq <= DISCONNECT_AFTER);
    const missedDuringOutage = FIXTURE.filter((entry) => entry.seq > DISCONNECT_AFTER && entry.seq <= 55);
    const afterReconnect = FIXTURE.filter((entry) => entry.seq > 55);

    for (const { seq, chunk } of beforeDisconnect) {
      await reference.write(chunk);
      referenceSeq = seq;
      desktop.sendRawPty(SID, seq, chunk);
    }
    await waitForSyncState(handle.page, `${label}: live before disconnect`, (s) => s.phase === 'live' && s.lastSeq === DISCONNECT_AFTER);

    // Actually close the relay socket — per the relay Durable Object, a
    // desktop socket closing (without a role successor already present)
    // proactively closes the phone's socket too, driving it into its own
    // reconnect/backoff loop exactly as a real network drop would.
    const oldDesktop = desktop;
    oldDesktop.close();

    // The "PTY" keeps producing output the phone never receives while the
    // desktop is gone — advance the ground-truth reference only.
    for (const { seq, chunk } of missedDuringOutage) {
      await reference.write(chunk);
      referenceSeq = seq;
    }

    // Reconnect: a fresh encrypted desktop peer for the SAME pairing/room.
    desktop = createSimulatedDesktop(relayUrl, pairing, {
      sessions: [{ sid: SID, cwd: 'C:\\work\\sync-e2e' }],
    });
    desktop.setSnapshotProvider(SID, () => ({ seq: referenceSeq, data: reference.serialize() }));
    await waitFor(`${label}: phone re-authenticates with the reconnected desktop`, () => desktop.authenticatedCount >= 1, 30_000);

    // Resume the live stream — the first post-reconnect chunk is far ahead
    // of the phone's last known seq, so this is what actually triggers the
    // (automatic) gap-recovery snapshot request.
    for (const { seq, chunk } of afterReconnect) {
      await reference.write(chunk);
      referenceSeq = seq;
      desktop.sendRawPty(SID, seq, chunk);
    }

    await assertExactParity(label, handle.page, reference.serialize());
    assert.equal(oldDesktop.snapshotRequests.length, 1, `${label}: only the initial snapshot request before the outage`);
    assert.equal(desktop.snapshotRequests.length, 1, `${label}: exactly one gap-recovery snapshot request after reconnecting`);
    assertNoBrowserErrors(label, handle);
    reference.dispose();
  } finally {
    await handle.close();
    desktop.close();
  }
}

// ---------------------------------------------------------------------------
// Case 5: session-switch race — an old sid's tail arrives after selecting
// the new sid and must be dropped without affecting the new session.
// ---------------------------------------------------------------------------

async function caseSessionSwitchRace(relayUrl) {
  const label = 'session-switch-race';
  const pairing = generatePairingIdentity();
  const desktop = createSimulatedDesktop(relayUrl, pairing, {
    sessions: [
      { sid: SID, cwd: 'C:\\work\\sync-e2e-a' },
      { sid: SID_B, cwd: 'C:\\work\\sync-e2e-b' },
    ],
  });
  const handle = await openPhonePage(relayUrl, pairing);
  try {
    await waitForBridge(handle.page);
    await waitForSyncState(handle.page, `${label}: session A auto-selected`, (s) => s.sid === SID);
    await waitFor(`${label}: initial session.snapshot request for A`, () => desktop.snapshotRequests.length >= 1, 15_000);
    const dims = await waitForNewResize(desktop, 0);

    const referenceA = createReferenceTerminal(dims.cols, dims.rows);
    const referenceB = createReferenceTerminal(dims.cols, dims.rows);
    let seqA = 0;
    let seqB = 0;
    desktop.setSnapshotProvider(SID, () => ({ seq: seqA, data: referenceA.serialize() }));
    desktop.setSnapshotProvider(SID_B, () => ({ seq: seqB, data: referenceB.serialize() }));

    const A_LIVE_UPTO = 40;
    const aLive = FIXTURE.filter((entry) => entry.seq <= A_LIVE_UPTO);
    for (const { seq, chunk } of aLive) {
      await referenceA.write(chunk);
      seqA = seq;
      desktop.sendRawPty(SID, seq, chunk);
    }
    await waitForSyncState(handle.page, `${label}: A live before switching`, (s) => s.sid === SID && s.phase === 'live' && s.lastSeq === A_LIVE_UPTO);

    // Drive the switch through the REAL UI (no page-injected store calls):
    // open the drawer, then select session B.
    await handle.page.getByRole('button', { name: 'Sessions menu' }).click();
    await handle.page.locator(`[data-session-id="${SID_B}"]`).click();

    const afterSwitch = await getSyncState(handle.page);
    assert.equal(afterSwitch.sid, SID_B, `${label}: selecting B must switch sync state to B synchronously`);

    // The race: an old-sid (A) tail arrives AFTER B was selected, while
    // B's own snapshot may still be in flight. It carries text that is
    // NOT part of any fixture chunk, so its (correct) absence is
    // unambiguous — it can never be confused with B's own legitimate
    // content.
    //
    // Deliberately uses the ungated `sendInFlightPty` here, NOT the
    // production-gated `sendRawPty`: this frame models one already having
    // been handed to the transport for A in the instant before this
    // peer's `subscribedSid` actually flips to B (a real race the gate
    // itself cannot reproduce, since by the time this line runs the
    // desktop may or may not have processed the phone's new
    // `session.snapshot: B` request yet). Using the gated send here would
    // make the "must not appear" assertion below pass vacuously whenever
    // that race already flipped `subscribedSid` to B — never actually
    // exercising the client's own old-sid discard — instead of proving it.
    desktop.sendInFlightPty(SID, A_LIVE_UPTO + 1, 'STALE-SID-A-TAIL-MUST-NOT-APPEAR\r\n');

    const bFull = FIXTURE; // full, independent fixture playback for B.
    for (const { seq, chunk } of bFull) {
      await referenceB.write(chunk);
      seqB = seq;
      desktop.sendRawPty(SID_B, seq, chunk);
    }

    await assertExactParity(label, handle.page, referenceB.serialize(), ['STALE-SID-A-TAIL-MUST-NOT-APPEAR']);
    const finalState = await getSyncState(handle.page);
    assert.equal(finalState.sid, SID_B, `${label}: final sid must still be B`);
    assertNoBrowserErrors(label, handle);
    referenceA.dispose();
    referenceB.dispose();
  } finally {
    await handle.close();
    desktop.close();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const publicRelayUrl = configuredRelayUrl();
  let relayUrl = publicRelayUrl;
  let port = null;
  if (!relayUrl) {
    port = await reservePort();
    const started = await startWrangler(port);
    wrangler = started.child;
    relayUrl = started.relayUrl;
  } else {
    console.log(`[mobile-terminal-sync] using public CCSM_RELAY_URL=${publicRelayUrl}`);
  }

  browser = await chromium.launch({ headless: true });

  const cases = [
    ['duplicate-and-stale', caseDuplicateAndStale],
    ['snapshot-live-overlap', caseSnapshotLiveOverlap],
    ['gap-recovery', caseGapRecovery],
    ['disconnect-during-burst', caseDisconnectDuringBurst],
    ['session-switch-race', caseSessionSwitchRace],
  ];

  const results = [];
  for (const [name, fn] of cases) {
    const startedAt = Date.now();
    try {
      await fn(relayUrl);
      const ms = Date.now() - startedAt;
      results.push({ name, ok: true, ms });
      console.log(`[mobile-terminal-sync] PASS case=${name} (${ms}ms)`);
    } catch (error) {
      const ms = Date.now() - startedAt;
      results.push({ name, ok: false, ms, error });
      console.error(`[mobile-terminal-sync] FAIL case=${name} (${ms}ms):`, error);
    }
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    throw new Error(
      `${failed.length}/${results.length} fault-injection case(s) failed: ${failed.map((r) => r.name).join(', ')}`,
    );
  }

  console.log('[mobile-terminal-sync] PASS exact buffer parity across 5 fault cases');
}

try {
  await main();
} catch (error) {
  console.error('[mobile-terminal-sync] FAIL', error);
  process.exitCode = 1;
} finally {
  for (const context of [...openHandles]) {
    await context.close().catch(() => undefined);
  }
  await browser?.close();
  await stopExactChild(wrangler);
  cleanupWranglerLocalState();
}

// See scripts/harness-e2e-mobile-remote-relay.mjs for why: Playwright/
// Chromium (and Wrangler's dependency tree) can leave a handle open that
// keeps the event loop alive after every resource here has already been
// explicitly closed and every assertion has already run — exit codes are
// finalized by this point, so force the exit rather than hang forever.
process.exit(process.exitCode ?? 0);
