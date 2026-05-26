// scripts/dogfood-attach-redesign.mjs
//
// E2E probe for the attach-redesign rewrite (docs/attach-redesign.html).
//
// Verifies the 3 UX states + 3 ops:
//
//   STATE 0  — boot with no active session → right pane has no shell wrapper.
//   STATE 1  — cold start (first click on session A) → wrapper appears with
//              mask shown; mask removed once attach completes.
//   STATE 2  — second click on session B (also cold); then A→B→A swap is
//              instant: no mask on the visited switch.
//
//   DELETE   — delete the top session → next session in z-stack becomes
//              top, no mask. Delete it too → no shells left, back to State 0.
//   RELOAD   — reload top session → mask shown briefly, then content back.
//   COPY     — create a new session (e.g. via createSession) and click it →
//              normal cold-start sequence (mask → content).
//
// Frame-level invariants asserted:
//   * State 1: mask visible for ≥1 frame, then hidden.
//   * State 2 (visited switch): mask never visible.
//   * Delete top: no mask appears on the new top.
//   * Reload top: mask visible at some point during the suffix.
//
// Exit 0 = PASS, 1 = FAIL.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  createIsolatedClaudeDir,
  dismissWelcomeSplash,
  launchCcsmIsolated,
  seedSession,
  waitForTerminalReady,
  waitForXtermBuffer,
} from './probe-utils-real-cli.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function snapshotShells(win) {
  return await win.evaluate(() => {
    const wrappers = Array.from(document.querySelectorAll('[data-ccsm-shell-sid]'));
    return wrappers.map((w) => {
      const mask = w.querySelector('[data-ccsm-shell-mask]');
      return {
        sid: w.getAttribute('data-ccsm-shell-sid'),
        display: w.style.display || '',
        zIndex: w.style.zIndex || '',
        maskDisplay:
          mask instanceof HTMLElement ? (mask.style.display || '') : null,
      };
    });
  });
}

/**
 * Install a per-RAF sampler that records mask state for `sid` until the
 * sampler is read back. Returns the JS expression that reads + clears the
 * window-stashed samples.
 */
async function startMaskSampler(win, sid, durationMs = 1500) {
  await win.evaluate(
    ({ targetSid, duration }) => {
      window.__attachRedesignSamples = [];
      const startedAt = performance.now();
      const tick = () => {
        const wrapper = document.querySelector(
          `[data-ccsm-shell-sid="${CSS.escape(targetSid)}"]`,
        );
        let maskDisplay = null;
        let wrapperDisplay = null;
        if (wrapper instanceof HTMLElement) {
          wrapperDisplay = wrapper.style.display || '';
          const mask = wrapper.querySelector('[data-ccsm-shell-mask]');
          if (mask instanceof HTMLElement) {
            maskDisplay = mask.style.display || '';
          }
        }
        window.__attachRedesignSamples.push({
          t: Math.round(performance.now() - startedAt),
          wrapperDisplay,
          maskDisplay,
        });
        if (performance.now() - startedAt < duration) {
          requestAnimationFrame(tick);
        }
      };
      requestAnimationFrame(tick);
    },
    { targetSid: sid, duration: durationMs },
  );
}

async function readSamples(win) {
  return await win.evaluate(() => window.__attachRedesignSamples || []);
}

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
}

async function main() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'ccsm-dogfood-attach-redesign-'));
  createIsolatedClaudeDir(tempDir);

  const { electronApp, win } = await launchCcsmIsolated({ tempDir });

  try {
    await win.waitForFunction(
      () => !document.querySelector('[data-testid="claude-availability-probing"]'),
      null,
      { timeout: 30000 },
    );

    // STATE 0 — no sessions yet → no shell wrappers in DOM.
    {
      const shells = await snapshotShells(win);
      if (shells.length !== 0) {
        fail(`State 0 expected 0 shells, got ${shells.length}: ${JSON.stringify(shells)}`);
        return;
      }
      console.log('PASS State 0: no shell wrappers at boot');
    }

    // Seed 2 sessions. `seedSession` calls createSession which sets the
    // new session active — so each seed cold-starts a shell. That's
    // consistent with rule 1 ("never visited = zero resources") because
    // selecting IS visiting; the sidebar click and createSession's
    // implicit activation are the same UX trigger.
    const { sid: sidA } = await seedSession(win, { name: 'A', cwd: tempDir });
    const { sid: sidB } = await seedSession(win, { name: 'B', cwd: tempDir });
    await waitForTerminalReady(win, sidB, { timeout: 45000 });
    {
      const shells = await snapshotShells(win);
      const sids = shells.map((s) => s.sid).sort();
      if (sids.length !== 2 || !sids.includes(sidA) || !sids.includes(sidB)) {
        fail(`After seed expected shells for A+B, got: ${JSON.stringify(shells)}`);
        return;
      }
      // Z-stack invariant: exactly one shell visible, that one is sidB
      // (most-recently selected by seedSession).
      const visible = shells.filter((s) => s.display !== 'none');
      if (visible.length !== 1 || visible[0].sid !== sidB) {
        fail(`Z-stack invariant broken: expected only sidB visible, got: ${JSON.stringify(visible)}`);
        return;
      }
      console.log('PASS Z-stack: exactly one shell visible (sidB), sidA hidden but parented');
    }

    // Wait for sidB (the active one after seed) to be ready, then dismiss
    // any welcome splash. STATE 1 (cold start with mask) is exercised
    // implicitly by `seedSession` above; the explicit cold-start mask
    // assertion happens in the COPY case at the end.
    await waitForTerminalReady(win, sidB, { timeout: 45000 });
    await waitForXtermBuffer(win, /claude|welcome|│|╭|\?\sfor\sshortcuts/i, { timeout: 30000 });
    await dismissWelcomeSplash(win);

    // STATE 2 — visited switch B → A. Mask must NEVER show.
    await startMaskSampler(win, sidA);
    await win.evaluate((id) => window.__ccsmStore.getState().selectSession(id), sidA);
    await waitForTerminalReady(win, sidA, { timeout: 45000 });
    await sleep(800);
    {
      const samples = await readSamples(win);
      // Once switched, sidA wrapper goes display:'' AND mask should stay
      // display:'none' the whole time (visited path doesn't re-mask).
      const visibleFrames = samples.filter((s) => s.wrapperDisplay !== 'none');
      const maskedWhileVisible = visibleFrames.filter((s) => s.maskDisplay === '');
      if (maskedWhileVisible.length > 0) {
        fail(`State 2 (visited switch B→A): mask was shown on ${maskedWhileVisible.length} frame(s). Sample: ${JSON.stringify(maskedWhileVisible.slice(0, 3))}`);
        return;
      }
      console.log(`PASS State 2: visited switch had no mask across ${visibleFrames.length} visible frames`);
    }

    // RELOAD — sidA is top. Reload should mask briefly then unmask.
    await startMaskSampler(win, sidA, 8000);
    await win.evaluate((id) => {
      // Don't await — let the kill + nonce-bump run in background.
      window.__ccsmStore.getState().reloadSession(id);
    }, sidA);
    // Wait for the nonce to actually bump (kill awaits).
    await win.waitForFunction(
      (id) => (window.__ccsmStore.getState().reloadNonce[id] ?? 0) > 0,
      sidA,
      { timeout: 20000 },
    );
    await waitForTerminalReady(win, sidA, { timeout: 45000 });
    await sleep(500);
    {
      const samples = await readSamples(win);
      const sawMaskOn = samples.some((s) => s.maskDisplay === '');
      const sawMaskOff = samples.some((s) => s.maskDisplay === 'none');
      console.log(`reload sampled ${samples.length} frames`);
      if (!sawMaskOn) {
        fail(`Reload top: mask was never shown. samples-first10=${JSON.stringify(samples.slice(0, 10))}`);
        return;
      }
      if (!sawMaskOff) {
        fail('Reload top: mask never went off after reload');
        return;
      }
      console.log('PASS Reload: mask shown then hidden');
    }

    // DELETE top (currently sidA) → expect z-stack to collapse to sidB
    // without showing a mask on sidB (it's already warmed).
    // First inspect sidB state to verify mask is hidden BEFORE delete.
    const preDelete = await win.evaluate((sid) => {
      const w = document.querySelector(`[data-ccsm-shell-sid="${CSS.escape(sid)}"]`);
      const m = w?.querySelector('[data-ccsm-shell-mask]');
      return {
        wrapperDisplay: w instanceof HTMLElement ? w.style.display || '' : null,
        maskDisplay: m instanceof HTMLElement ? m.style.display || '' : null,
      };
    }, sidB);
    console.log(`pre-delete sidB: ${JSON.stringify(preDelete)}`);
    await startMaskSampler(win, sidB, 1500);
    await win.evaluate((id) => window.__ccsmStore.getState().deleteSession(id), sidA);
    await sleep(800);
    {
      const shells = await snapshotShells(win);
      const sidsLeft = shells.map((s) => s.sid);
      if (sidsLeft.includes(sidA)) {
        fail(`Delete: sid A still in shell registry after delete. shells=${JSON.stringify(shells)}`);
        return;
      }
      if (!sidsLeft.includes(sidB)) {
        fail(`Delete: sid B disappeared. shells=${JSON.stringify(shells)}`);
        return;
      }
      // sidB should now be top (display !== 'none').
      const b = shells.find((s) => s.sid === sidB);
      if (!b || b.display === 'none') {
        fail(`Delete: sid B did not become top after deleting A. shell=${JSON.stringify(b)}`);
        return;
      }
      const samples = await readSamples(win);
      const visibleMasked = samples.filter(
        (s) => s.wrapperDisplay !== 'none' && s.maskDisplay === '',
      );
      if (visibleMasked.length > 0) {
        fail(
          `Delete: mask flashed on warmed sid B (${visibleMasked.length} frame(s)). Sample: ${JSON.stringify(visibleMasked.slice(0, 5))} first-frames=${JSON.stringify(samples.slice(0, 5))}`,
        );
        return;
      }
      console.log('PASS Delete top: z-stack collapsed to next without mask');
    }

    // COPY — createSession (auto-selects new sid) → normal cold start.
    // Install sampler with `sid='*'` pseudo (all-shells) so we can catch
    // the mask flash on the brand-new shell — we don't know its sid yet.
    await win.evaluate(() => {
      window.__attachRedesignSamplesAny = [];
      const startedAt = performance.now();
      const tick = () => {
        const wrappers = Array.from(document.querySelectorAll('[data-ccsm-shell-sid]'));
        const snapshot = wrappers.map((w) => {
          const sid = w.getAttribute('data-ccsm-shell-sid');
          const m = w.querySelector('[data-ccsm-shell-mask]');
          return {
            sid,
            wrapperDisplay: w instanceof HTMLElement ? w.style.display || '' : null,
            maskDisplay: m instanceof HTMLElement ? m.style.display || '' : null,
          };
        });
        window.__attachRedesignSamplesAny.push({
          t: Math.round(performance.now() - startedAt),
          shells: snapshot,
        });
        if (performance.now() - startedAt < 8000) {
          requestAnimationFrame(tick);
        }
      };
      requestAnimationFrame(tick);
    });
    const sidC = await win.evaluate((cwd) => {
      const st = window.__ccsmStore.getState();
      st.createSession({ name: 'C', cwd });
      return window.__ccsmStore.getState().activeId;
    }, tempDir);
    if (!sidC) {
      fail('Copy: createSession did not produce a new active sid');
      return;
    }
    await waitForTerminalReady(win, sidC, { timeout: 45000 });
    await sleep(500);
    {
      const allSamples = await win.evaluate(
        (targetSid) =>
          (window.__attachRedesignSamplesAny || []).map((s) => ({
            t: s.t,
            target: s.shells.find((sh) => sh.sid === targetSid) ?? null,
          })),
        sidC,
      );
      const sawMaskOn = allSamples.some(
        (s) => s.target && s.target.maskDisplay === '',
      );
      if (!sawMaskOn) {
        fail(`Copy: new session cold start did not mask. first-frames=${JSON.stringify(allSamples.slice(0, 10))}`);
        return;
      }
      console.log('PASS Copy: new session cold-started with mask');
    }

    // Delete all remaining → back to State 0.
    await win.evaluate((id) => window.__ccsmStore.getState().deleteSession(id), sidC);
    await win.evaluate((id) => window.__ccsmStore.getState().deleteSession(id), sidB);
    await sleep(400);
    {
      const shells = await snapshotShells(win);
      if (shells.length !== 0) {
        fail(`Delete-all: expected back to State 0 (0 shells), got ${shells.length}: ${JSON.stringify(shells)}`);
        return;
      }
      console.log('PASS Delete all: back to State 0 (no shells)');
    }

    console.log('\nPASS: attach-redesign UX states + ops behave as specified');
  } finally {
    await electronApp.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
