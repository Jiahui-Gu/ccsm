// Workflow group ⑤ — voice MODEL-DOWNLOAD happy-path e2e harness.
//
// Proves the runtime whisper-model download flow end-to-end through the REAL
// prod bundle: the new Settings "Voice" tab (src/components/settings/
// VoicePane.tsx) → window.ccsmVoice.downloadModel(tier) → IPC
// voice:downloadModel → downloadTier() in electron/voice/modelDownloader.ts →
// real fetch/Transform/pipeline/WriteStream/rename/isTierDownloaded →
// voice:modelStatus broadcasts → VoicePane UI flips to "Installed".
//
// The ONLY thing stubbed is the network. We replace the main-process global
// `fetch` (via electronApp.evaluate, BEFORE triggering the download) with a
// fake that returns a Response-like carrying a tiny Node Readable body and a
// matching content-length header. Everything downstream of fetch is the REAL
// production downloader: the Transform meter, stream/promises.pipeline into
// fs.createWriteStream, the size-vs-content-length integrity check, the atomic
// tmp→dest rename, and isTierDownloaded(). The real `downloading`→`ready`
// status broadcasts drive the real VoicePane subscription.
//
// We do NOT need a terminal session or the fake Anthropic API — Settings is a
// pure renderer surface. We seed minimal onboarding so the app mounts cleanly.
//
// Run: `node scripts/harness-e2e-voice-download.mjs`

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  createIsolatedClaudeDir,
  launchCcsmIsolated,
} from './probe-utils-real-cli.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const VOICE_TIERS = ['tiny', 'base', 'small', 'medium', 'large-v3', 'large-v3-turbo'];
const TARGET_TIER = 'tiny';
const FAKE_BODY = 'FAKE_GGML_MODEL_BYTES_'.repeat(64); // small, non-empty, multi-chunk

const SCREENSHOT_PATH = path.resolve('scripts/.artifacts/voice-download-evidence.png');

// Minimal onboarding seed so App mounts without first-run gates.
function seedOnboarding(tempDir) {
  writeFileSync(
    path.join(tempDir, '.claude.json'),
    JSON.stringify(
      {
        hasCompletedOnboarding: true,
        bypassPermissionsModeAccepted: true,
        customApiKeyResponses: { approved: ['fake-ci-key'] },
        projects: {},
      },
      null,
      2,
    ),
  );
  writeFileSync(path.join(tempDir, 'settings.json'), '{}');
  writeFileSync(path.join(tempDir, 'settings.local.json'), '{}');
}

// ============================================================================
// Test seam: replace main-process global fetch with a tiny fake payload.
// ============================================================================
//
// modelDownloader.downloadFromUrl does:
//   const res = await fetch(url, { signal });
//   if (!res.ok || !res.body) throw ...
//   const total = Number(res.headers.get('content-length'));
//   await pipeline(res.body, meter, fs.createWriteStream(tmp), { signal });
//
// So our fake must return: { ok:true, status:200, headers.get('content-length')
// = byteLength, body = a REAL Node Readable } so the real pipeline consumes it.
async function installFetchStub(electronApp, bodyText) {
  const err = await electronApp.evaluate(async ({}, text) => {
    try {
      // `require` is not injected into Playwright's main-process evaluate
      // scope, but the main module's require IS reachable (verified at runtime).
      const nodeRequire = process.mainModule.require.bind(process.mainModule);
      const { Readable } = nodeRequire('node:stream');
      const buf = Buffer.from(text, 'utf8');
      const total = buf.length;
      if (globalThis.__realFetch) return null; // idempotent
      globalThis.__realFetch = globalThis.fetch;
      globalThis.__fetchStubCalls = [];
      globalThis.fetch = async (url, _opts) => {
        globalThis.__fetchStubCalls.push(String(url));
        // Emit the body as several small chunks with a tiny delay between
        // them so the real Transform meter crosses its 200ms progress-throttle
        // and broadcasts at least one real `downloading` status — letting the
        // harness observe the progress UI before `ready`.
        const CHUNKS = 6;
        const per = Math.ceil(buf.length / CHUNKS);
        async function* gen() {
          for (let i = 0; i < buf.length; i += per) {
            await new Promise((r) => setTimeout(r, 90));
            yield buf.subarray(i, Math.min(buf.length, i + per));
          }
        }
        return {
          ok: true,
          status: 200,
          body: Readable.from(gen()),
          headers: {
            get: (name) =>
              String(name).toLowerCase() === 'content-length'
                ? String(total)
                : null,
          },
        };
      };
      return null;
    } catch (e) {
      return String(e && e.stack ? e.stack : e);
    }
  }, bodyText);
  if (err) throw new Error(`installFetchStub: ${err}`);
}

async function readFetchStubCalls(electronApp) {
  return await electronApp.evaluate(() => globalThis.__fetchStubCalls || []);
}

// Resolve the isolated userData dir so we can confirm the real file landed.
async function getModelsDir(electronApp) {
  return await electronApp.evaluate(({ app }) => {
    const p = process.mainModule.require('node:path');
    return p.join(app.getPath('userData'), 'models');
  });
}

// ============================================================================
// Case: voice-model-download
// ============================================================================

async function caseVoiceModelDownload({ electronApp, win }) {
  // 0. Wait for the app to settle past any availability probe.
  await win
    .waitForFunction(
      () => !document.querySelector('[data-testid="claude-availability-probing"]'),
      null,
      { timeout: 30_000 },
    )
    .catch(() => {});

  // 1. Stub network BEFORE any download is triggered.
  await installFetchStub(electronApp, FAKE_BODY);

  // 2. Open Settings via the Ctrl+, global shortcut (App.useShortcutHandlers).
  await win.keyboard.press('Control+Comma');

  // Settings dialog tab list is role="tablist" aria-label = settings title.
  const voiceTab = win.locator('#settings-tab-voice');
  await voiceTab.waitFor({ state: 'visible', timeout: 15_000 });

  // 3. Click the Voice tab.
  await voiceTab.click();

  // The Voice pane root carries `data-voice-pane`; the tier list is a
  // role="radiogroup" aria-label="Model" with one role="radio" per tier whose
  // <span class="font-mono"> holds the tier id.
  const pane = win.locator('[data-voice-pane]');
  await pane.waitFor({ state: 'visible', timeout: 10_000 });

  const radiogroup = win.locator('[data-voice-pane] [role="radiogroup"]');
  await radiogroup.waitFor({ state: 'visible', timeout: 10_000 });

  // Assert all 6 tiers render (matched by the mono tier-name span text).
  const renderedTiers = [];
  for (const tier of VOICE_TIERS) {
    const cell = radiogroup.locator('span.font-mono', { hasText: new RegExp(`^${escapeRe(tier)}$`) });
    const count = await cell.count();
    if (count > 0) renderedTiers.push(tier);
  }
  if (renderedTiers.length !== VOICE_TIERS.length) {
    throw new Error(
      `expected all 6 tiers to render; got ${renderedTiers.length}: [${renderedTiers.join(', ')}]`,
    );
  }
  console.log(`[case=voice-model-download] all 6 tiers rendered: [${renderedTiers.join(', ')}]`);

  // Locate the TARGET_TIER row (the role="radio" ancestor of its mono span).
  const targetRow = radiogroup
    .locator('[role="radio"]')
    .filter({ has: win.locator('span.font-mono', { hasText: new RegExp(`^${escapeRe(TARGET_TIER)}$`) }) })
    .first();
  await targetRow.waitFor({ state: 'visible', timeout: 10_000 });

  // 4. Click the Download button inside the target tier's row. The pane is
  // locale-driven (EN "Download" / ZH "下载"); in a not-downloaded,
  // not-downloading row the Download button is the row's only button, so match
  // structurally rather than by text.
  const downloadBtn = targetRow.locator('button').first();
  if ((await downloadBtn.count()) === 0) {
    const btnTexts = await targetRow.locator('button').allInnerTexts();
    throw new Error(
      `Download button not found in ${TARGET_TIER} row; buttons present: ${JSON.stringify(btnTexts)}`,
    );
  }
  await downloadBtn.click();

  // 5a. Assert a `downloading` status reached the UI: progress bar OR the
  // "Downloading…" text appears. The bar is a div with width style under the
  // row; the text matches the en `voice.downloading` template prefix.
  let sawDownloading = false;
  {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      // Locale-agnostic: the "Downloading…" line and the cancel button both
      // carry a mono progress label; the progress bar is the accent-filled div.
      const downloadingText = await targetRow
        .locator('span.font-mono')
        .filter({ hasText: /(Downloading|下载中)/ })
        .count();
      const bar = await targetRow.locator('div.bg-accent').count();
      if (downloadingText > 0 || bar > 0) {
        sawDownloading = true;
        break;
      }
      await sleep(80);
    }
  }
  // The chunked+delayed fake stream guarantees the real meter crosses its
  // 200ms throttle, so a `downloading` frame MUST reach the UI.
  if (!sawDownloading) {
    throw new Error('no downloading status / progress bar reached the VoicePane UI');
  }
  console.log(`[case=voice-model-download] saw a downloading frame: ${sawDownloading}`);

  // 5b. Assert the UI flips to installed: the "Installed" badge appears for
  // the target tier (rendered when downloaded && !selected). Poll with a
  // deadline like the input harness.
  // 5b. Assert the UI flips to installed. Once downloaded, the row no longer
  // offers a Download button — it shows the "Installed" badge (EN "Installed"
  // / ZH "已下载") with a "Use" button, or "In use" if auto-selected. The
  // most robust locale-agnostic signal is: the Download button disappears AND
  // the installed/in-use badge text is present. Poll with a deadline.
  let installed = false;
  const INSTALLED_RE = /(Installed|In use|已下载|使用中)/;
  {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const badge = await targetRow
        .locator('span')
        .filter({ hasText: INSTALLED_RE })
        .count();
      const downloadedDisk = await isTierOnDisk(electronApp, TARGET_TIER);
      if (badge > 0 || downloadedDisk) {
        // The download-affordance is gone once the model has landed: in a
        // downloaded row the only button is "Use" (EN/ZH), and a downloading
        // row shows a Cancel button + progress bar. We assert the installed
        // badge text directly — that's the PR's installed-state UI.
        if (badge > 0) {
          installed = true;
          break;
        }
      }
      await sleep(150);
    }
  }

  // Confirm the REAL downloader actually wrote the model file to disk.
  const onDisk = await isTierOnDisk(electronApp, TARGET_TIER);
  const calls = await readFetchStubCalls(electronApp);

  if (!onDisk) {
    throw new Error(
      `model file for ${TARGET_TIER} not on disk after download.\n` +
        `  fetch stub calls: ${JSON.stringify(calls)}`,
    );
  }
  if (calls.length === 0) {
    throw new Error('fetch stub was never called — real downloader did not run');
  }
  console.log(
    `[case=voice-model-download] real downloader wrote model to disk; fetch hit: ${calls[0]}`,
  );

  if (!installed) {
    // UI never reflected installed even though the file landed → still a fail
    // for the UI-flow claim, surface diagnostics.
    const rowHtml = await targetRow.evaluate((el) => el.outerHTML).catch(() => '<unavailable>');
    throw new Error(
      `model landed on disk but VoicePane never showed the installed state for ${TARGET_TIER}.\n` +
        `  row html: ${rowHtml.slice(0, 600)}`,
    );
  }
  console.log(`[case=voice-model-download] VoicePane shows ${TARGET_TIER} installed ✓`);

  // 6. Screenshot the post-download (installed) Voice pane.
  mkdirSync(path.dirname(SCREENSHOT_PATH), { recursive: true });
  await win.screenshot({ path: SCREENSHOT_PATH });
  const sz = statSync(SCREENSHOT_PATH).size;
  if (sz <= 0) throw new Error(`screenshot written but empty: ${SCREENSHOT_PATH}`);
  console.log(`[case=voice-model-download] screenshot: ${SCREENSHOT_PATH} (${sz} bytes)`);
}

async function isTierOnDisk(electronApp, tier) {
  const dir = await getModelsDir(electronApp);
  const file = path.join(dir, `ggml-${tier}.bin`);
  try {
    return statSync(file).size > 0;
  } catch {
    return false;
  }
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============================================================================
// Runner
// ============================================================================

async function main() {
  if (!existsSync(path.resolve('dist/renderer/index.html'))) {
    console.error('dist/renderer/index.html missing — run `npm run build` first');
    process.exit(2);
  }

  const results = [];
  const harnessStart = Date.now();

  let isolated = null;
  let launched = null;
  try {
    isolated = await createIsolatedClaudeDir();
    seedOnboarding(isolated.tempDir);
    launched = await launchCcsmIsolated({ tempDir: isolated.tempDir });
    const ctx = { electronApp: launched.electronApp, win: launched.win, tempDir: isolated.tempDir };
    console.log(`\n[HARNESS=voice-download] launch ready (tempDir=${isolated.tempDir})`);

    const t0 = Date.now();
    console.log(`\n[HARNESS=voice-download] >>> case: voice-model-download`);
    try {
      await caseVoiceModelDownload(ctx);
      const ms = Date.now() - t0;
      results.push({ name: 'voice-model-download', ok: true, ms });
      console.log(`[HARNESS=voice-download] <<< PASS voice-model-download (${ms}ms)`);
    } catch (err) {
      const ms = Date.now() - t0;
      results.push({ name: 'voice-model-download', ok: false, ms, error: String(err?.stack || err) });
      console.error(`[HARNESS=voice-download] <<< FAIL voice-model-download (${ms}ms): ${err?.message || err}`);
    }
  } finally {
    if (launched?.electronApp) try { await launched.electronApp.close(); } catch (_) { /* ignore */ }
    launched?.cleanup?.();
    isolated?.cleanup?.();
  }

  const totalMs = Date.now() - harnessStart;
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log('\n===== SUMMARY =====');
  for (const r of results) {
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(24)} ${r.ms}ms`);
    if (!r.ok && r.error) console.log(`        ${r.error.split('\n')[0]}`);
  }
  console.log(`  total: ${passed}/${results.length} passed, ${(totalMs / 1000).toFixed(1)}s wall`);
  process.exit(failed === 0 ? 0 : 1);
}

const _entryUrlMain =
  process.argv[1] && new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;
if (_entryUrlMain && import.meta.url === _entryUrlMain) {
  main().catch((err) => {
    console.error('[HARNESS=voice-download] unhandled top-level error:', err?.stack || err);
    process.exit(1);
  });
}
