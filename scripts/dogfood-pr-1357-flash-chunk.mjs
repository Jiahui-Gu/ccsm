// Dogfood validation: PR #1357 — refactor: remove CCSM_WARM_XTERM flag.
//
// Warm-xterm is now the only path. This probe reconstructs the flash +
// chunk-loss invariants from PR #1355 Round 3 (which validated the
// flag-ON behaviour) against the post-refactor, no-flag world.
//
// Method:
//   1. Stand up a stub-claude shim on PATH so node-pty produces a
//      deterministic 200-line burst per session.
//   2. Seed sessions A and B; wait for each to emit "stub-claude ready"
//      (post-burst).
//   3. Switch A↔B at least 6 times. During each switch, run a fast
//      sampler reading `__ccsmTerm.buffer.active.{viewportY,baseY}` at
//      ~5 ms cadence for ~300 ms.
//   4. Assert flashInvariant: no sampled instant has `viewportY < baseY`.
//      That asymmetric collapse is the 冲顶 signature (warm path should
//      eliminate it by construction — no term.reset(), no snapshot
//      rewrite).
//   5. Assert chunkInvariant: after the final switch, every numbered
//      line "line 001".."line 200" is present in each session's full
//      buffer scrape. (Round 2 saw chunk loss; Round 3 fixed it; this
//      verifies the fix survived the refactor.)
//
// Output: scratch/dogfood-pr-1357-flash-chunk.json + console verdict.

import {
  createIsolatedClaudeDir,
  launchCcsmIsolated,
  seedSession,
  waitForTerminalReady,
} from './probe-utils-real-cli.mjs';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const STUB_PATH = path.join(__dirname, 'fixtures', 'stub-claude.mjs');
const OUT_PATH = path.join(REPO_ROOT, 'scratch', 'dogfood-pr-1357-flash-chunk.json');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function setupClaudeShim() {
  const shimDir = mkdtempSync(path.join(tmpdir(), 'ccsm-stub-claude-'));
  const sentinelPath = path.join(REPO_ROOT, 'scratch', `stub-sentinel-1357-${Date.now()}.log`);
  // claude.cmd shim — Windows-only path. node-pty's spawn on Windows
  // honours `where claude.cmd` (the npm-shim shape claudeResolver looks
  // up). The .cmd dispatches to `node "<stub>" <args>` so node-pty sees
  // a real win32 process.
  const stubFwd = STUB_PATH.replace(/\\/g, '\\\\');
  const cmd = `@echo off\r\nnode "${STUB_PATH}" %*\r\n`;
  const cmdPath = path.join(shimDir, 'claude.cmd');
  writeFileSync(cmdPath, cmd, 'utf8');
  return { shimDir, sentinelPath, cmdPath };
}

async function readBuffer(win) {
  return await win.evaluate(() => {
    const term = window.__ccsmTerm;
    if (!term || !term.buffer || !term.buffer.active) return null;
    const buf = term.buffer.active;
    const total = buf.length;
    const out = [];
    for (let i = 0; i < total; i++) {
      const line = buf.getLine(i);
      if (line) out.push(line.translateToString(true));
    }
    return { full: out.join('\n'), length: total, viewportY: buf.viewportY, baseY: buf.baseY };
  });
}

async function waitForBufferRegex(win, re, { timeout = 30000 } = {}) {
  const deadline = Date.now() + timeout;
  let last = '';
  while (Date.now() < deadline) {
    const b = await readBuffer(win);
    if (b) {
      last = b.full;
      if (re.test(b.full)) return b;
    }
    await sleep(150);
  }
  throw new Error(`waitForBufferRegex: ${re} not found in ${timeout}ms. Tail:\n${last.slice(-400)}`);
}

async function selectSession(win, sid) {
  await win.evaluate((s) => {
    const useStore = window.__ccsmStore;
    if (!useStore) throw new Error('store not ready');
    useStore.getState().selectSession(s);
  }, sid);
}

async function sampleAcrossSwitch(win, durationMs = 300, periodMs = 5) {
  const start = Date.now();
  const samples = [];
  while (Date.now() - start < durationMs) {
    const v = await win.evaluate(() => {
      const t = window.__ccsmTerm;
      if (!t || !t.buffer || !t.buffer.active) return null;
      return { vY: t.buffer.active.viewportY, bY: t.buffer.active.baseY, len: t.buffer.active.length };
    });
    if (v) samples.push({ dt: Date.now() - start, ...v });
    await sleep(periodMs);
  }
  return samples;
}

function scrapeBurstPresence(fullBuf) {
  const missing = [];
  for (let i = 1; i <= 200; i++) {
    const n = String(i).padStart(3, '0');
    if (!fullBuf.includes(`line ${n}`)) missing.push(`line ${n}`);
  }
  return { presentCount: 200 - missing.length, missing };
}

async function main() {
  if (!existsSync(path.join(REPO_ROOT, 'scratch'))) {
    mkdirSync(path.join(REPO_ROOT, 'scratch'), { recursive: true });
  }

  const { shimDir, sentinelPath } = setupClaudeShim();
  // Minimal PATH: shim first, then System32 (for cmd.exe internals + node-pty
  // helpers), then nodejs (for `node "<stub>"`).
  // Prepend shim to existing PATH (keeping the full env). Originally
  // tried a minimised PATH per Round 2, but Electron's launch needs
  // user PATH dirs (proxy DLLs, GPU drivers) — minimising 504-ed the
  // firstWindow timeout. Prepending is sufficient: `where claude.cmd`
  // hits the shim first.
  const minimalPath = [shimDir, process.env.PATH ?? process.env.Path ?? ''].join(';');

  const { tempDir } = await createIsolatedClaudeDir();
  const { electronApp, win, userDataDir } = await launchCcsmIsolated({
    tempDir,
    env: {
      PATH: minimalPath,
      Path: minimalPath,
      CCSM_LOG_ENABLE_FILE: '1',
      STUB_BURST_DELAY_MS: '500',
      STUB_SENTINEL_FILE: sentinelPath,
    },
  });

  const result = {
    summary: {
      label: 'pr-1357-flash-chunk',
      warm: 'always-on (flag removed)',
      nSwitches: 0,
      sidA: null,
      sidB: null,
      shimDir,
      sentinelPath,
      mainLogPath: path.join(userDataDir, 'logs', 'main.log'),
      userDataDir,
    },
    perSwitch: [],
    error: null,
    verdict: 'PENDING',
  };

  try {
    // Seed A
    const { sid: sidA } = await seedSession(win, { name: 'flash-A', cwd: REPO_ROOT });
    result.summary.sidA = sidA;
    await waitForTerminalReady(win, sidA, { timeout: 15000 });
    await waitForBufferRegex(win, /stub-claude ready/, { timeout: 30000 });
    const aBuf = await readBuffer(win);
    result.summary.aBurstAfterSeed = scrapeBurstPresence(aBuf?.full ?? '');

    // Seed B (this switches active session to B)
    const { sid: sidB } = await seedSession(win, { name: 'flash-B', cwd: REPO_ROOT });
    result.summary.sidB = sidB;
    await waitForTerminalReady(win, sidB, { timeout: 15000 });
    await waitForBufferRegex(win, /stub-claude ready/, { timeout: 30000 });
    const bBuf = await readBuffer(win);
    result.summary.bBurstAfterSeed = scrapeBurstPresence(bBuf?.full ?? '');

    // 6 switches A↔B
    const targets = [sidA, sidB, sidA, sidB, sidA, sidB];
    let totalFlash = 0;
    let totalFlashSamples = 0;
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      const samplePromise = sampleAcrossSwitch(win, 350, 5);
      await selectSession(win, target);
      const samples = await samplePromise;
      const flashes = samples.filter((s) => s.vY < s.bY);
      const final = samples[samples.length - 1] ?? null;
      const burstAfter = scrapeBurstPresence((await readBuffer(win))?.full ?? '');
      if (flashes.length > 0) totalFlash++;
      totalFlashSamples += flashes.length;
      result.perSwitch.push({
        i,
        target: target.slice(0, 8),
        sampleCount: samples.length,
        finalVy: final?.vY ?? null,
        finalBy: final?.bY ?? null,
        finalLen: final?.len ?? null,
        flashSamples: flashes.length,
        burstPresent: burstAfter.presentCount,
        burstMissing: burstAfter.missing,
        flashSnap: flashes.slice(0, 5),
      });
      await sleep(120);
    }

    result.summary.nSwitches = targets.length;
    result.summary.totalFlashSwitches = totalFlash;
    result.summary.totalFlashSamples = totalFlashSamples;
    const totalMissing = result.perSwitch.reduce((acc, p) => acc + p.burstMissing.length, 0);
    result.summary.totalMissingSwitches = result.perSwitch.filter((p) => p.burstMissing.length > 0).length;
    result.summary.flashInvariant = totalFlashSamples === 0 ? 'PASS' : 'FAIL';
    result.summary.chunkInvariant = totalMissing === 0 ? 'PASS' : 'FAIL';
    result.verdict =
      result.summary.flashInvariant === 'PASS' && result.summary.chunkInvariant === 'PASS'
        ? 'ALL INVARIANTS PASS'
        : `FAIL: flash=${result.summary.flashInvariant} chunk=${result.summary.chunkInvariant}`;
  } catch (e) {
    result.error = String(e?.stack || e?.message || e);
    result.verdict = `FAIL: ${e?.message || e}`;
  } finally {
    try { writeFileSync(OUT_PATH, JSON.stringify(result, null, 2), 'utf8'); } catch (_) { /* ignore */ }
    try { await electronApp.close(); } catch (_) { /* ignore */ }
    console.log(result.verdict);
    console.log(`JSON: ${OUT_PATH}`);
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
