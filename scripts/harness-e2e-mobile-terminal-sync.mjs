// Deterministic geometry-authority + buffer-parity fault harness for the
// mobile remote terminal sync pipeline.
//
// Pre-req: `npm run build`.
// Run:    node scripts/harness-e2e-mobile-terminal-sync.mjs
//
// This harness locks the simulated desktop authority to canonical 120x30
// (epoch 0), proves phone viewport changes never send `session.resize`, and
// validates exact SerializeAddon parity against an authoritative
// @xterm/headless terminal across nine fault cases.

import assert from 'node:assert/strict';

import { chromium } from 'playwright';
import headlessPkg from '@xterm/headless';
import serializeAddonPkg from '@xterm/addon-serialize';

import {
  configuredRelayUrl,
  createSimulatedDesktop,
  generatePairingIdentity,
  installConfiguredMobileAssets,
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
  sequencedFixture,
} from './fixtures/mobile-remote-pty-fixture.mjs';

const { Terminal: HeadlessTerminal } = headlessPkg;
const { SerializeAddon } = serializeAddonPkg;

const SID = 'sync-e2e';
const SID_B = 'sync-e2e-b';
const FIXTURE = sequencedFixture(1);
const FINAL_SEQ = FIXTURE[FIXTURE.length - 1].seq;
const CANONICAL_GEOMETRY = Object.freeze({ cols: 120, rows: 30, epoch: 0 });
const RESIZE_GEOMETRY_A = Object.freeze({ cols: 156, rows: 36, epoch: 1 });
const RESIZE_GEOMETRY_B = Object.freeze({ cols: 168, rows: 40, epoch: 2 });
const OVERFLOW_GEOMETRY = Object.freeze({ cols: 170, rows: 40, epoch: 1 });

const OVERFLOW_FINAL_SEQ = 257;
const OVERFLOW_FIXTURE = [
  ...FIXTURE,
  ...Array.from({ length: OVERFLOW_FINAL_SEQ - FIXTURE.length }, (_, index) => ({
    seq: FIXTURE.length + index + 1,
    chunk: `OVERFLOW-FILL-${String(index + 1).padStart(3, '0')} ${'y'.repeat(64)}\r\n`,
  })),
];

let wrangler = null;
let browser = null;
const openHandles = new Set();

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
    resize(nextCols, nextRows) {
      terminal.resize(nextCols, nextRows);
    },
    serialize() {
      return serializeAddon.serialize();
    },
    dispose() {
      terminal.dispose();
    },
  };
}

async function openPhonePage(relayUrl, pairing) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  openHandles.add(context);
  const page = await context.newPage();
  await installConfiguredMobileAssets(page, relayUrl);
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

async function waitForCanonicalLive(page, label) {
  return waitForSyncState(
    page,
    `${label}: canonical geometry installed`,
    (state) =>
      state.phase === 'live' &&
      state.geometry?.cols === CANONICAL_GEOMETRY.cols &&
      state.geometry?.rows === CANONICAL_GEOMETRY.rows &&
      state.geometry?.epoch === CANONICAL_GEOMETRY.epoch,
    20_000,
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

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function assertNoSessionResizeMessages(desktop, label) {
  assert.equal(
    desktop.receivedMessages.some((message) => message?.type === 'session.resize'),
    false,
    `${label}: phone must not send session.resize`,
  );
}

async function assertExactParity(
  label,
  page,
  expectedSerialize,
  {
    expectedLastSeq = FINAL_SEQ,
    expectedGeometry = null,
    verifyFixtureMarkers = true,
    extraAbsentMarkers = [],
  } = {},
) {
  const actual = await waitForExactSerialize(page, expectedSerialize);
  assert.equal(actual, expectedSerialize, `${label}: exact buffer parity`);

  if (verifyFixtureMarkers) {
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
  }
  for (const marker of extraAbsentMarkers) {
    assert.equal(actual.includes(marker), false, `${label}: marker "${marker}" must be absent`);
  }

  const state = await getSyncState(page);
  assert.equal(state.phase, 'live', `${label}: sync phase must return to live`);
  assert.equal(state.lastSeq, expectedLastSeq, `${label}: lastSeq must reach ${expectedLastSeq}`);
  if (expectedGeometry) {
    assert.deepEqual(state.geometry, expectedGeometry, `${label}: installed geometry must match barrier geometry`);
  }
}

function assertNoBrowserErrors(label, handle) {
  assert.deepEqual(handle.consoleErrors, [], `${label}: no browser console errors`);
  assert.deepEqual(handle.pageErrors, [], `${label}: no browser pageerror events`);
}

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
    await waitForCanonicalLive(handle.page, label);

    const reference = createReferenceTerminal(CANONICAL_GEOMETRY.cols, CANONICAL_GEOMETRY.rows);
    let referenceSeq = 0;
    desktop.setSnapshotProvider(SID, () => ({ seq: referenceSeq, snapshot: reference.serialize() }));

    const DUPLICATE_SEQ = 60;
    for (const { seq, chunk } of FIXTURE) {
      await reference.write(chunk);
      referenceSeq = seq;
      desktop.sendRawPty(SID, seq, chunk, CANONICAL_GEOMETRY.epoch);
      if (seq === DUPLICATE_SEQ) {
        desktop.sendRawPty(SID, DUPLICATE_SEQ, 'POISON-DUPLICATE-MUST-NOT-APPEAR\r\n', CANONICAL_GEOMETRY.epoch);
        desktop.sendRawPty(SID, DUPLICATE_SEQ - 1, 'POISON-STALE-MUST-NOT-APPEAR\r\n', CANONICAL_GEOMETRY.epoch);
      }
    }

    await assertExactParity(label, handle.page, reference.serialize(), {
      extraAbsentMarkers: ['POISON-DUPLICATE-MUST-NOT-APPEAR', 'POISON-STALE-MUST-NOT-APPEAR'],
      expectedGeometry: CANONICAL_GEOMETRY,
    });
    assert.equal(
      desktop.snapshotRequests.length,
      1,
      `${label}: duplicate/stale chunks must not trigger an extra snapshot request`,
    );
    assertNoSessionResizeMessages(desktop, label);
    assertNoBrowserErrors(label, handle);
    reference.dispose();
  } finally {
    await handle.close();
    desktop.close();
  }
}

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
    await waitForCanonicalLive(handle.page, label);

    const reference = createReferenceTerminal(CANONICAL_GEOMETRY.cols, CANONICAL_GEOMETRY.rows);
    let referenceSeq = 0;
    desktop.setSnapshotProvider(SID, () => null);

    const GAP_AT = 51;
    const BUFFERED_TAIL = [GAP_AT + 1, GAP_AT + 2];
    const upToGap = FIXTURE.filter((entry) => entry.seq < GAP_AT);
    const gapChunk = FIXTURE.find((entry) => entry.seq === GAP_AT);
    const bufferedChunks = FIXTURE.filter((entry) => BUFFERED_TAIL.includes(entry.seq));
    const rest = FIXTURE.filter((entry) => entry.seq > BUFFERED_TAIL[BUFFERED_TAIL.length - 1]);

    for (const { seq, chunk } of upToGap) {
      await reference.write(chunk);
      referenceSeq = seq;
      desktop.sendRawPty(SID, seq, chunk, CANONICAL_GEOMETRY.epoch);
    }
    await waitForSyncState(handle.page, `${label}: live before the gap`, (s) => s.phase === 'live' && s.lastSeq === GAP_AT - 1);

    await reference.write(gapChunk.chunk);
    referenceSeq = GAP_AT;
    const snapshotAnswer = { seq: GAP_AT, snapshot: reference.serialize() };

    for (const { seq, chunk } of bufferedChunks) {
      await reference.write(chunk);
      referenceSeq = seq;
      desktop.sendRawPty(SID, seq, chunk, CANONICAL_GEOMETRY.epoch);
    }

    const overlapping = await waitForSyncState(
      handle.page,
      `${label}: buffered tail present while snapshot withheld`,
      (s) => s.phase === 'syncing' && s.snapshotRequested === true && s.bufferedSeqs.length >= BUFFERED_TAIL.length,
    );
    assert.deepEqual(
      [...overlapping.bufferedSeqs].sort((a, b) => a - b),
      BUFFERED_TAIL,
      `${label}: both post-gap chunks must buffer during overlap`,
    );

    await waitForSyncState(
      handle.page,
      `${label}: overlap state remains withheld until snapshot release`,
      (s) =>
        s.phase === 'syncing' &&
        s.snapshotRequested === true &&
        [...s.bufferedSeqs].sort((a, b) => a - b).join(',') === BUFFERED_TAIL.join(','),
      10_000,
    );
    desktop.sendSnapshotNow(SID, snapshotAnswer.seq, snapshotAnswer.snapshot, CANONICAL_GEOMETRY);

    for (const { seq, chunk } of rest) {
      await reference.write(chunk);
      referenceSeq = seq;
      desktop.sendRawPty(SID, seq, chunk, CANONICAL_GEOMETRY.epoch);
    }

    await assertExactParity(label, handle.page, reference.serialize(), {
      expectedGeometry: CANONICAL_GEOMETRY,
    });
    assert.equal(
      desktop.snapshotRequests.length,
      2,
      `${label}: one overlap gap must trigger exactly one recovery snapshot request`,
    );
    assertNoSessionResizeMessages(desktop, label);
    assertNoBrowserErrors(label, handle);
    reference.dispose();
  } finally {
    await handle.close();
    desktop.close();
  }
}

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
    await waitForCanonicalLive(handle.page, label);

    const reference = createReferenceTerminal(CANONICAL_GEOMETRY.cols, CANONICAL_GEOMETRY.rows);
    let referenceSeq = 0;
    desktop.setSnapshotProvider(SID, () => ({ seq: referenceSeq, snapshot: reference.serialize() }));

    const OMITTED_SEQ = 71;
    for (const { seq, chunk } of FIXTURE) {
      await reference.write(chunk);
      referenceSeq = seq;
      if (seq === OMITTED_SEQ) continue;
      desktop.sendRawPty(SID, seq, chunk, CANONICAL_GEOMETRY.epoch);
    }

    await assertExactParity(label, handle.page, reference.serialize(), {
      expectedGeometry: CANONICAL_GEOMETRY,
    });
    assert.equal(
      desktop.snapshotRequests.length,
      2,
      `${label}: one sequence gap must trigger exactly one recovery snapshot request`,
    );
    assertNoSessionResizeMessages(desktop, label);
    assertNoBrowserErrors(label, handle);
    reference.dispose();
  } finally {
    await handle.close();
    desktop.close();
  }
}

async function caseFutureEpochBeforeBarrier(relayUrl) {
  const label = 'future-epoch-before-barrier';
  const pairing = generatePairingIdentity();
  const desktop = createSimulatedDesktop(relayUrl, pairing, {
    sessions: [{ sid: SID, cwd: 'C:\\work\\sync-e2e' }],
  });
  const handle = await openPhonePage(relayUrl, pairing);
  try {
    await waitForBridge(handle.page);
    await waitFor(`${label}: initial session.snapshot request`, () => desktop.snapshotRequests.length >= 1, 15_000);
    await waitForCanonicalLive(handle.page, label);

    const reference = createReferenceTerminal(CANONICAL_GEOMETRY.cols, CANONICAL_GEOMETRY.rows);
    desktop.setSnapshotProvider(SID, () => null);

    const FUTURE_SEQ = 51;
    const prefix = FIXTURE.filter((entry) => entry.seq < FUTURE_SEQ);
    const futureChunk = FIXTURE.find((entry) => entry.seq === FUTURE_SEQ);
    const rest = FIXTURE.filter((entry) => entry.seq > FUTURE_SEQ);

    for (const { seq, chunk } of prefix) {
      await reference.write(chunk);
      desktop.sendRawPty(SID, seq, chunk, CANONICAL_GEOMETRY.epoch);
    }
    await waitForSyncState(handle.page, `${label}: live at epoch 0 prefix`, (s) => s.phase === 'live' && s.lastSeq === FUTURE_SEQ - 1);

    reference.resize(RESIZE_GEOMETRY_A.cols, RESIZE_GEOMETRY_A.rows);
    const barrierSeq = FUTURE_SEQ - 1;
    const barrierSnapshot = reference.serialize();

    await reference.write(futureChunk.chunk);
    desktop.sendRawPty(SID, futureChunk.seq, futureChunk.chunk, RESIZE_GEOMETRY_A.epoch);

    const waitingForBarrier = await waitForSyncState(
      handle.page,
      `${label}: future-epoch chunk buffers until the authoritative barrier`,
      (s) =>
        s.phase === 'syncing' &&
        s.snapshotRequested === true &&
        s.recoveryReason === 'future-geometry' &&
        s.bufferedSeqs.length === 1,
    );
    await waitFor(
      `${label}: future-epoch chunk triggers a recovery snapshot request`,
      () => desktop.snapshotRequests.length === 2,
      20_000,
    );
    assert.equal(
      waitingForBarrier.geometry?.epoch,
      CANONICAL_GEOMETRY.epoch,
      `${label}: geometry must remain canonical until the barrier arrives`,
    );
    assert.equal(
      waitingForBarrier.lastSeq,
      FUTURE_SEQ - 1,
      `${label}: future-epoch chunk must not advance lastSeq before the barrier`,
    );
    assert.deepEqual(
      waitingForBarrier.bufferedSeqs,
      [FUTURE_SEQ],
      `${label}: exactly the future-epoch chunk must remain buffered`,
    );

    desktop.sendResizeBarrier(SID, barrierSeq, barrierSnapshot, RESIZE_GEOMETRY_A);

    for (const { seq, chunk } of rest) {
      await reference.write(chunk);
      desktop.sendRawPty(SID, seq, chunk, RESIZE_GEOMETRY_A.epoch);
    }

    await assertExactParity(label, handle.page, reference.serialize(), {
      expectedGeometry: RESIZE_GEOMETRY_A,
    });
    assert.equal(
      desktop.snapshotRequests.length,
      2,
      `${label}: future-epoch chunk must trigger exactly one recovery snapshot request`,
    );
    assertNoSessionResizeMessages(desktop, label);
    assertNoBrowserErrors(label, handle);
    reference.dispose();
  } finally {
    await handle.close();
    desktop.close();
  }
}

async function caseActiveOutputDuringResize(relayUrl) {
  const label = 'active-output-during-resize';
  const pairing = generatePairingIdentity();
  const desktop = createSimulatedDesktop(relayUrl, pairing, {
    sessions: [{ sid: SID, cwd: 'C:\\work\\sync-e2e' }],
  });
  const handle = await openPhonePage(relayUrl, pairing);
  try {
    await waitForBridge(handle.page);
    await waitFor(`${label}: initial session.snapshot request`, () => desktop.snapshotRequests.length >= 1, 15_000);
    await waitForCanonicalLive(handle.page, label);

    const reference = createReferenceTerminal(CANONICAL_GEOMETRY.cols, CANONICAL_GEOMETRY.rows);
    let referenceSeq = 0;
    desktop.setSnapshotProvider(SID, () => null);

    const PREFIX_SEQ = 4;
    const prefix = FIXTURE.filter((entry) => entry.seq <= PREFIX_SEQ);
    const epochOnePrefix = FIXTURE.filter((entry) => entry.seq > PREFIX_SEQ && entry.seq <= PREFIX_SEQ + 2);
    const epochOneTail = FIXTURE.filter((entry) => entry.seq > PREFIX_SEQ + 2);

    for (const { seq, chunk } of prefix) {
      await reference.write(chunk);
      referenceSeq = seq;
      desktop.sendRawPty(SID, seq, chunk, CANONICAL_GEOMETRY.epoch);
    }
    await waitForSyncState(handle.page, `${label}: live old-epoch prefix`, (s) => s.phase === 'live' && s.lastSeq === PREFIX_SEQ);

    const beforeResizeState = await getSyncState(handle.page);

    reference.resize(RESIZE_GEOMETRY_A.cols, RESIZE_GEOMETRY_A.rows);
    const barrierSeq = PREFIX_SEQ;
    const barrierSnapshot = reference.serialize();

    for (const { seq, chunk } of epochOnePrefix) {
      await reference.write(chunk);
      referenceSeq = seq;
      desktop.sendRawPty(SID, seq, chunk, RESIZE_GEOMETRY_A.epoch);
    }

    const waitingForBarrier = await waitForSyncState(
      handle.page,
      `${label}: epoch-1 chunks buffered until barrier`,
      (s) => s.phase === 'syncing' && s.snapshotRequested === true && s.recoveryReason === 'future-geometry' && s.bufferedSeqs.length >= 2,
    );
    assert.deepEqual(waitingForBarrier.bufferedSeqs, [PREFIX_SEQ + 1, PREFIX_SEQ + 2], `${label}: exactly two epoch-1 chunks must buffer before barrier`);

    desktop.sendResizeBarrier(SID, barrierSeq, barrierSnapshot, RESIZE_GEOMETRY_A);

    for (const { seq, chunk } of epochOneTail) {
      await reference.write(chunk);
      referenceSeq = seq;
      desktop.sendRawPty(SID, seq, chunk, RESIZE_GEOMETRY_A.epoch);
    }

    await assertExactParity(label, handle.page, reference.serialize(), {
      expectedGeometry: RESIZE_GEOMETRY_A,
    });

    const afterResizeState = await getSyncState(handle.page);
    assert.equal(
      afterResizeState.installSnapshotCount,
      beforeResizeState.installSnapshotCount + 1,
      `${label}: one authoritative resize barrier must install exactly one additional snapshot`,
    );
    assert.equal(
      afterResizeState.terminalResetCount,
      beforeResizeState.terminalResetCount + 1,
      `${label}: one authoritative resize barrier must trigger exactly one additional reset`,
    );
    assert.equal(afterResizeState.lastSeq, FINAL_SEQ, `${label}: contiguous epoch-1 tail must reach FINAL_SEQ`);

    assert.equal(
      desktop.snapshotRequests.length,
      2,
      `${label}: future-geometry buffering during active output must trigger one recovery snapshot request`,
    );
    assertNoSessionResizeMessages(desktop, label);
    assertNoBrowserErrors(label, handle);
    reference.dispose();
  } finally {
    await handle.close();
    desktop.close();
  }
}

async function caseStaleAndSupersededBarriers(relayUrl) {
  const label = 'stale-and-superseded-barriers';
  const pairing = generatePairingIdentity();
  const desktop = createSimulatedDesktop(relayUrl, pairing, {
    sessions: [{ sid: SID, cwd: 'C:\\work\\sync-e2e' }],
  });
  const handle = await openPhonePage(relayUrl, pairing);
  try {
    await waitForBridge(handle.page);
    await waitFor(`${label}: initial session.snapshot request`, () => desktop.snapshotRequests.length >= 1, 15_000);
    await waitForCanonicalLive(handle.page, label);

    const reference = createReferenceTerminal(CANONICAL_GEOMETRY.cols, CANONICAL_GEOMETRY.rows);
    let referenceSeq = 0;
    desktop.setSnapshotProvider(SID, () => null);

    const EPOCH_ONE_START = 51;
    const EPOCH_ONE_END = 80;
    const prefix = FIXTURE.filter((entry) => entry.seq < EPOCH_ONE_START);
    const epochOneWindow = FIXTURE.filter((entry) => entry.seq >= EPOCH_ONE_START && entry.seq <= EPOCH_ONE_END);
    const epochTwoTail = FIXTURE.filter((entry) => entry.seq > EPOCH_ONE_END);

    for (const { seq, chunk } of prefix) {
      await reference.write(chunk);
      referenceSeq = seq;
      desktop.sendRawPty(SID, seq, chunk, CANONICAL_GEOMETRY.epoch);
    }
    await waitForSyncState(handle.page, `${label}: live old geometry before epoch transition`, (s) => s.phase === 'live' && s.lastSeq === EPOCH_ONE_START - 1);

    reference.resize(RESIZE_GEOMETRY_A.cols, RESIZE_GEOMETRY_A.rows);
    for (const { seq, chunk } of epochOneWindow) {
      await reference.write(chunk);
      referenceSeq = seq;
      if (seq <= EPOCH_ONE_START + 1) {
        desktop.sendRawPty(SID, seq, chunk, RESIZE_GEOMETRY_A.epoch);
      }
    }

    await waitForSyncState(
      handle.page,
      `${label}: epoch-1 chunks buffered pending barrier`,
      (s) => s.phase === 'syncing' && s.snapshotRequested === true && s.recoveryReason === 'future-geometry',
    );

    const staleBarrierSnapshot = reference.serialize();
    const staleBarrierSeq = EPOCH_ONE_END;

    reference.resize(RESIZE_GEOMETRY_B.cols, RESIZE_GEOMETRY_B.rows);
    const supersedingBarrierSnapshot = reference.serialize();
    const supersedingBarrierSeq = EPOCH_ONE_END;

    desktop.sendResizeBarrier(SID, supersedingBarrierSeq, supersedingBarrierSnapshot, RESIZE_GEOMETRY_B);
    desktop.sendSnapshotNow(SID, staleBarrierSeq, staleBarrierSnapshot, RESIZE_GEOMETRY_A);

    for (const { seq, chunk } of epochTwoTail) {
      await reference.write(chunk);
      referenceSeq = seq;
      desktop.sendRawPty(SID, seq, chunk, RESIZE_GEOMETRY_B.epoch);
    }

    await assertExactParity(label, handle.page, reference.serialize(), {
      expectedGeometry: RESIZE_GEOMETRY_B,
    });
    assert.equal(
      desktop.snapshotRequests.length,
      2,
      `${label}: stale/superseded barrier flow must trigger one recovery snapshot request`,
    );
    assertNoSessionResizeMessages(desktop, label);
    assertNoBrowserErrors(label, handle);
    reference.dispose();
  } finally {
    await handle.close();
    desktop.close();
  }
}

async function caseBufferOverflowRecovery(relayUrl) {
  const label = 'buffer-overflow-recovery';
  const pairing = generatePairingIdentity();
  const desktop = createSimulatedDesktop(relayUrl, pairing, {
    sessions: [{ sid: SID, cwd: 'C:\\work\\sync-e2e' }],
  });
  const handle = await openPhonePage(relayUrl, pairing);
  try {
    await waitForBridge(handle.page);
    await waitFor(`${label}: initial session.snapshot request`, () => desktop.snapshotRequests.length >= 1, 15_000);
    await waitForCanonicalLive(handle.page, label);

    const reference = createReferenceTerminal(CANONICAL_GEOMETRY.cols, CANONICAL_GEOMETRY.rows);
    reference.resize(OVERFLOW_GEOMETRY.cols, OVERFLOW_GEOMETRY.rows);
    let referenceSeq = 0;

    for (const { seq, chunk } of OVERFLOW_FIXTURE) {
      await reference.write(chunk);
      referenceSeq = seq;
      desktop.sendRawPty(SID, seq, chunk, OVERFLOW_GEOMETRY.epoch);
    }

    await waitForSyncState(
      handle.page,
      `${label}: 257th future-epoch chunk triggers overflow recovery`,
      (s) => s.phase === 'syncing' && s.snapshotRequested === true && s.recoveryReason === 'buffer-overflow',
    );

    desktop.sendResizeBarrier(SID, referenceSeq, reference.serialize(), OVERFLOW_GEOMETRY);

    await assertExactParity(label, handle.page, reference.serialize(), {
      expectedLastSeq: OVERFLOW_FINAL_SEQ,
      expectedGeometry: OVERFLOW_GEOMETRY,
      verifyFixtureMarkers: true,
    });
    assert.equal(
      desktop.snapshotRequests.length,
      2,
      `${label}: overflow recovery must trigger exactly one additional snapshot request`,
    );
    assertNoSessionResizeMessages(desktop, label);
    assertNoBrowserErrors(label, handle);
    reference.dispose();
  } finally {
    await handle.close();
    desktop.close();
  }
}

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
    await waitForCanonicalLive(handle.page, label);

    const reference = createReferenceTerminal(CANONICAL_GEOMETRY.cols, CANONICAL_GEOMETRY.rows);
    let referenceSeq = 0;
    desktop.setSnapshotProvider(SID, () => ({ seq: referenceSeq, snapshot: reference.serialize() }));

    const DISCONNECT_AFTER = 40;
    const beforeDisconnect = FIXTURE.filter((entry) => entry.seq <= DISCONNECT_AFTER);
    const missedDuringOutage = FIXTURE.filter((entry) => entry.seq > DISCONNECT_AFTER && entry.seq <= 55);
    const afterReconnect = FIXTURE.filter((entry) => entry.seq > 55);

    for (const { seq, chunk } of beforeDisconnect) {
      await reference.write(chunk);
      referenceSeq = seq;
      desktop.sendRawPty(SID, seq, chunk, CANONICAL_GEOMETRY.epoch);
    }
    await waitForSyncState(handle.page, `${label}: live before disconnect`, (s) => s.phase === 'live' && s.lastSeq === DISCONNECT_AFTER);

    const oldDesktop = desktop;
    oldDesktop.close();

    for (const { seq, chunk } of missedDuringOutage) {
      await reference.write(chunk);
      referenceSeq = seq;
    }

    desktop = createSimulatedDesktop(relayUrl, pairing, {
      sessions: [{ sid: SID, cwd: 'C:\\work\\sync-e2e' }],
    });
    desktop.setSnapshotProvider(SID, () => ({ seq: referenceSeq, snapshot: reference.serialize() }));
    await waitFor(`${label}: phone re-authenticates`, () => desktop.authenticatedCount >= 1, 30_000);

    for (const { seq, chunk } of afterReconnect) {
      await reference.write(chunk);
      referenceSeq = seq;
      desktop.sendRawPty(SID, seq, chunk, CANONICAL_GEOMETRY.epoch);
    }

    await assertExactParity(label, handle.page, reference.serialize(), {
      expectedGeometry: CANONICAL_GEOMETRY,
    });
    assert.equal(oldDesktop.snapshotRequests.length, 1, `${label}: old desktop sees only initial snapshot request`);
    assert.equal(desktop.snapshotRequests.length, 1, `${label}: reconnected desktop sees one recovery snapshot request`);
    assertNoSessionResizeMessages(oldDesktop, `${label} (before outage)`);
    assertNoSessionResizeMessages(desktop, `${label} (after reconnect)`);
    assertNoBrowserErrors(label, handle);
    reference.dispose();
  } finally {
    await handle.close();
    desktop.close();
  }
}

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
    await waitForCanonicalLive(handle.page, label);

    const referenceA = createReferenceTerminal(CANONICAL_GEOMETRY.cols, CANONICAL_GEOMETRY.rows);
    const referenceB = createReferenceTerminal(CANONICAL_GEOMETRY.cols, CANONICAL_GEOMETRY.rows);
    let seqA = 0;
    let seqB = 0;
    desktop.setSnapshotProvider(SID, () => ({ seq: seqA, snapshot: referenceA.serialize() }));
    desktop.setSnapshotProvider(SID_B, () => ({ seq: seqB, snapshot: referenceB.serialize() }));

    const A_LIVE_UPTO = 40;
    for (const { seq, chunk } of FIXTURE.filter((entry) => entry.seq <= A_LIVE_UPTO)) {
      await referenceA.write(chunk);
      seqA = seq;
      desktop.sendRawPty(SID, seq, chunk, CANONICAL_GEOMETRY.epoch);
    }
    await waitForSyncState(handle.page, `${label}: A live before switching`, (s) => s.sid === SID && s.phase === 'live' && s.lastSeq === A_LIVE_UPTO);

    await handle.page.getByRole('button', { name: 'Sessions menu' }).click();
    await handle.page.locator(`[data-session-id="${SID_B}"]`).click();

    const afterSwitch = await getSyncState(handle.page);
    assert.equal(afterSwitch.sid, SID_B, `${label}: selecting B must switch sync state to B`);

    desktop.sendInFlightPty(SID, A_LIVE_UPTO + 1, 'STALE-SID-A-TAIL-MUST-NOT-APPEAR\r\n', CANONICAL_GEOMETRY.epoch);

    for (const { seq, chunk } of FIXTURE) {
      await referenceB.write(chunk);
      seqB = seq;
      desktop.sendRawPty(SID_B, seq, chunk, CANONICAL_GEOMETRY.epoch);
    }

    await assertExactParity(label, handle.page, referenceB.serialize(), {
      extraAbsentMarkers: ['STALE-SID-A-TAIL-MUST-NOT-APPEAR'],
      expectedGeometry: CANONICAL_GEOMETRY,
    });
    const finalState = await getSyncState(handle.page);
    assert.equal(finalState.sid, SID_B, `${label}: final sid must still be B`);
    assertNoSessionResizeMessages(desktop, label);
    assertNoBrowserErrors(label, handle);
    referenceA.dispose();
    referenceB.dispose();
  } finally {
    await handle.close();
    desktop.close();
  }
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
    console.log('[mobile-terminal-sync] using configured public relay');
  }

  browser = await chromium.launch({ headless: true });

  const cases = [
    ['duplicate-and-stale', caseDuplicateAndStale],
    ['snapshot-live-overlap', caseSnapshotLiveOverlap],
    ['gap-recovery', caseGapRecovery],
    ['future-epoch-before-barrier', caseFutureEpochBeforeBarrier],
    ['active-output-during-resize', caseActiveOutputDuringResize],
    ['stale-and-superseded-barriers', caseStaleAndSupersededBarriers],
    ['buffer-overflow-recovery', caseBufferOverflowRecovery],
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

  const failed = results.filter((result) => !result.ok);
  if (failed.length > 0) {
    throw new Error(
      `${failed.length}/${results.length} fault-injection case(s) failed: ${failed.map((result) => result.name).join(', ')}`,
    );
  }

  console.log('[mobile-terminal-sync] PASS exact buffer parity across 9 fault cases');
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

process.exit(process.exitCode ?? 0);
