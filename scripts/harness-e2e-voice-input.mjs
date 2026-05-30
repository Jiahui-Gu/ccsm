// Workflow group ⑤ — voice-input happy-path e2e harness.
//
// Pins the core voice-input contract end-to-end through the real prod
// bundle, isolated from the two hardware/external dependencies that make
// the production flow un-runnable in headless CI:
//
//   1. The microphone. `navigator.mediaDevices.getUserMedia` has no audio
//      device under headless Chromium, and even with one we can't feed it
//      deterministic samples. We stub `getUserMedia` + a minimal
//      `AudioContext` / `ScriptProcessorNode` in the renderer so the
//      recorder's `start()` succeeds and `stop()` sees a bounded buffer of
//      seeded PCM — enough samples to clear the recorder's
//      MIN_SAMPLES_16K (~300ms) silence gate.
//
//   2. Real Whisper transcription. `electron/voice/transcriber.ts` needs the
//      466 MB ggml-small.bin model + smart-whisper's N-API binding, neither
//      present in CI. We wrap the main-process `voice:transcribe` IPC
//      handler to return a canned `{ ok: true, text: 'hello from voice' }`,
//      bypassing the model entirely. This is the SAME interception technique
//      paste-fidelity uses on `pty:input` (ipcMain._invokeHandlers is a
//      mutable Map keyed by channel; contextBridge only freezes the
//      RENDERER namespace).
//
// What remains REAL and under test:
//   - The renderer recorder state machine (idle→recording→transcribing→idle).
//   - resampleTo16k on the seeded buffer.
//   - The IPC round-trip renderer → main → renderer (payload validation in
//     voiceIpc.validateVoicePayload runs against the real seeded Float32Array).
//   - pasteIntoActivePty injecting the transcript into the ACTIVE session's
//     pty — the exact production injection path, terminating at the same
//     `pty:input` handler.
//
// Core assertion (the no-auto-submit invariant): the transcript reaches the
// pty WITHOUT a trailing Enter (`\r`). The user reviews and submits
// themselves; voice must never auto-fire the prompt.
//
// Test seam: identical to harness-e2e-paste-fidelity.mjs — we observe the
// transcript at the main-process `pty:input` handler. The voice flow's
// `pasteIntoActivePty(() => getTopShell()?.term, sid, text)` issues exactly
// one `ccsmPty.input(sid, payload)`, handed verbatim to `entry.pty.write`.
//
// Group: shared. Single isolated electron launch.
//
// Run: `node scripts/harness-e2e-voice-input.mjs`

import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { writeFileSync } from 'node:fs';
import {
  createIsolatedClaudeDir,
  dismissFirstRunModals,
  launchCcsmIsolated,
  seedSession,
  waitForTerminalReady,
  waitForXtermBuffer,
} from './probe-utils-real-cli.mjs';
import { startFakeAnthropicApi } from './fixtures/fake-anthropic-api.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Seed claude's onboarding state into the isolated tempDir so the spawned
// CLI talks to the fake Anthropic API and never the real one. Mirrors
// harness-e2e-paste-fidelity.mjs#seedOnboarding.
function seedOnboarding(tempDir) {
  const trustedEntry = {
    allowedTools: [],
    mcpContextUris: [],
    mcpServers: {},
    enabledMcpjsonServers: [],
    disabledMcpjsonServers: [],
    hasClaudeMdExternalIncludesApproved: false,
    hasClaudeMdExternalIncludesWarningShown: false,
    hasTrustDialogAccepted: true,
    projectOnboardingSeenCount: 1,
  };
  const projects = {};
  projects[tempDir] = trustedEntry;
  const tempDirFwd = tempDir.replace(/\\/g, '/');
  if (tempDirFwd !== tempDir) projects[tempDirFwd] = trustedEntry;
  writeFileSync(
    path.join(tempDir, '.claude.json'),
    JSON.stringify(
      {
        hasCompletedOnboarding: true,
        bypassPermissionsModeAccepted: true,
        customApiKeyResponses: { approved: ['fake-ci-key'] },
        projects,
      },
      null,
      2,
    ),
  );
  writeFileSync(path.join(tempDir, 'settings.json'), '{}');
  writeFileSync(path.join(tempDir, 'settings.local.json'), '{}');
}

// ============================================================================
// CLI args
// ============================================================================

function parseArgs(argv) {
  const out = { only: null, skip: null };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--only=')) {
      out.only = arg.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg.startsWith('--skip=')) {
      out.skip = arg.slice('--skip='.length).split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/harness-e2e-voice-input.mjs [--only=name] [--skip=name]');
      for (const c of CASE_REGISTRY) console.log('  -', c.name);
      process.exit(0);
    }
  }
  return out;
}

// ============================================================================
// Test seam #1: wrap the main-process `pty:input` handler (observe transcript)
// ============================================================================
//
// Identical to harness-e2e-paste-fidelity.mjs. The voice injection's final
// hop is `window.ccsmPty.input(sid, transcript)` → main `pty:input` handler →
// `entry.pty.write`. We wrap the handler so the injected transcript lands in
// `globalThis.__voicePtyInputLog` before the real write runs.

async function installPtyInputProbe(electronApp) {
  await electronApp.evaluate(({ ipcMain }) => {
    if (globalThis.__voicePtyInputProbeInstalled) return;
    globalThis.__voicePtyInputProbeInstalled = true;
    globalThis.__voicePtyInputLog = [];
    const CHANNEL = 'pty:input';
    const map = ipcMain._invokeHandlers;
    if (!map || typeof map.get !== 'function') {
      globalThis.__voicePtyInputProbeError = 'ipcMain._invokeHandlers not a Map';
      return;
    }
    const orig = map.get(CHANNEL);
    if (typeof orig !== 'function') {
      globalThis.__voicePtyInputProbeError = `no handler registered for ${CHANNEL}`;
      return;
    }
    map.set(CHANNEL, (event, ...args) => {
      try {
        const [sid, data] = args;
        if (typeof data === 'string') {
          globalThis.__voicePtyInputLog.push({ sid, data, at: Date.now() });
        }
      } catch (_) { /* never break the IPC */ }
      return orig(event, ...args);
    });
  });
}

async function readPtyInputLog(electronApp, sid) {
  return await electronApp.evaluate((_e, s) => {
    const all = globalThis.__voicePtyInputLog || [];
    return all.filter((entry) => entry.sid === s).slice();
  }, sid);
}

async function clearPtyInputLog(electronApp) {
  await electronApp.evaluate(() => { globalThis.__voicePtyInputLog = []; });
}

// ============================================================================
// Test seam #2: wrap the main-process `voice:transcribe` handler (canned text)
// ============================================================================
//
// Bypass the 466 MB Whisper model + smart-whisper N-API. We replace the
// handler outright (not wrap) — the real `transcribe()` would fail with
// `{ ok: false, error: 'no-model' }` in CI, so there's no real behaviour to
// preserve. We DO keep the production payload-validation contract honest by
// re-running `voiceIpc.validateVoicePayload`'s rule inline: reject anything
// that isn't a non-empty bounded Float32Array, so the test still proves the
// renderer handed main a well-formed PCM buffer.

async function installVoiceTranscribeStub(electronApp, cannedText) {
  const err = await electronApp.evaluate(({ ipcMain }, text) => {
    const CHANNEL = 'voice:transcribe';
    const map = ipcMain._invokeHandlers;
    if (!map || typeof map.get !== 'function') {
      return 'ipcMain._invokeHandlers not a Map';
    }
    if (typeof map.get(CHANNEL) !== 'function') {
      return `no handler registered for ${CHANNEL}`;
    }
    // MAX_PCM_SAMPLES = 16000 * 60 * 10 (mirrors electron/ipc/voiceIpc.ts).
    const MAX_PCM_SAMPLES = 16000 * 60 * 10;
    globalThis.__voiceTranscribeCalls = [];
    map.set(CHANNEL, (_event, pcm) => {
      const valid =
        pcm instanceof Float32Array && pcm.length > 0 && pcm.length <= MAX_PCM_SAMPLES;
      globalThis.__voiceTranscribeCalls.push({
        valid,
        length: pcm instanceof Float32Array ? pcm.length : -1,
        at: Date.now(),
      });
      if (!valid) return { ok: false, error: 'empty' };
      return { ok: true, text };
    });
    return null;
  }, cannedText);
  if (err) throw new Error(`installVoiceTranscribeStub: ${err}`);
}

async function readTranscribeCalls(electronApp) {
  return await electronApp.evaluate(() => globalThis.__voiceTranscribeCalls || []);
}

// ============================================================================
// Test seam #3: stub the renderer mic so start() succeeds with seeded PCM
// ============================================================================
//
// useVoiceRecorder.start() calls `navigator.mediaDevices.getUserMedia({audio})`,
// `new AudioContext()`, `ctx.createMediaStreamSource(stream)`,
// `ctx.createScriptProcessor(4096,1,1)`, then wires
// `processor.onaudioprocess` to push `new Float32Array(e.inputBuffer
// .getChannelData(0))` onto its chunk list. stop() concatenates the chunks,
// resamples to 16k, and gates on MIN_SAMPLES_16K = 16000*0.3 = 4800 samples.
//
// We replace getUserMedia + AudioContext with deterministic stubs. The stub
// AudioContext reports sampleRate 48000; on `processor.connect(...)` it
// synchronously fires onaudioprocess enough times to seed > 4800 resampled
// samples (48k→16k is ratio 3, so we need > 14400 input samples; 4 chunks of
// 4096 = 16384 input → ~5461 at 16k, clearing the gate). Each chunk carries a
// small non-zero sine so the buffer isn't all-zero (defends against any
// future "all silence" short-circuit).

async function installMicStub(win) {
  await win.evaluate(() => {
    if (window.__voiceMicStubInstalled) return;
    window.__voiceMicStubInstalled = true;

    const SAMPLE_RATE = 48000;
    const CHUNK = 4096;
    const NUM_CHUNKS = 4; // 16384 input samples → ~5461 @16k > 4800 gate

    class FakeScriptProcessor {
      constructor() {
        this.onaudioprocess = null;
      }
      connect() {
        // Fire enough audio frames to clear the silence gate. Synchronous
        // so the harness doesn't race the audio thread.
        if (typeof this.onaudioprocess !== 'function') return;
        for (let n = 0; n < NUM_CHUNKS; n++) {
          const data = new Float32Array(CHUNK);
          for (let i = 0; i < CHUNK; i++) {
            // low-amplitude 440Hz-ish sine — non-zero, bounded
            data[i] = 0.2 * Math.sin((2 * Math.PI * 440 * (n * CHUNK + i)) / SAMPLE_RATE);
          }
          const evt = { inputBuffer: { getChannelData: () => data } };
          try { this.onaudioprocess(evt); } catch (_) { /* swallow */ }
        }
      }
      disconnect() {}
    }

    class FakeAudioContext {
      constructor() {
        this.sampleRate = SAMPLE_RATE;
        this.destination = {};
      }
      createMediaStreamSource() {
        return { connect: () => {} };
      }
      createScriptProcessor() {
        return new FakeScriptProcessor();
      }
      close() { return Promise.resolve(); }
    }

    // Stub getUserMedia → a stream with one stoppable track.
    const fakeStream = {
      getTracks: () => [{ stop: () => {} }],
    };
    if (!navigator.mediaDevices) {
      Object.defineProperty(navigator, 'mediaDevices', { value: {}, configurable: true });
    }
    navigator.mediaDevices.getUserMedia = () => Promise.resolve(fakeStream);

    window.AudioContext = FakeAudioContext;
    window.webkitAudioContext = FakeAudioContext;
  });
}

// ----------------------------------------------------------------------------
// Seam #4: neutralize clipboard-image pickup in the main process.
//
// pasteIntoActivePty calls ccsmPty.saveClipboardImage() FIRST and, if an image
// is present, injects the image path and returns — silently dropping the voice
// transcript (text branch). On shared desktop runners (mac/win) a PRIOR harness
// (terminal-paste-image) can leave a PNG on the SYSTEM clipboard that survives
// into this process, so saveClipboardImage returns that stale path and the
// voice path never reaches stdin. We can't stub the frozen renderer namespace
// (contextBridge deep-freezes window.ccsmPty), so we replace the main-process
// `pty:saveClipboardImage` handler to always report "no image", forcing the
// deterministic text branch this happy-path is meant to exercise.
// ----------------------------------------------------------------------------
async function installNoClipboardImageStub(electronApp) {
  await electronApp.evaluate(({ ipcMain }) => {
    const CHANNEL = 'pty:saveClipboardImage';
    const handlers = ipcMain._invokeHandlers;
    if (!handlers) throw new Error('ipcMain._invokeHandlers unavailable');
    ipcMain.removeHandler(CHANNEL);
    ipcMain.handle(CHANNEL, () => null);
  });
}

// ============================================================================
// Case: voice-happy-path
// ============================================================================

async function caseVoiceHappyPath({ electronApp, win, tempDir }) {
  await win.waitForFunction(
    () => !document.querySelector('[data-testid="claude-availability-probing"]'),
    null,
    { timeout: 30_000 },
  );

  const { sid } = await seedSession(win, { name: 'voice-probe', cwd: tempDir });
  if (!sid) throw new Error('seedSession returned no sid');

  await sleep(3000);
  await waitForTerminalReady(win, sid, { timeout: 60_000 });
  await waitForXtermBuffer(win, /trust|claude|welcome|│|╭|>/i, { timeout: 30_000 });
  await dismissFirstRunModals(win);

  const CANNED_TEXT = 'hello from voice';

  // Install all four seams before driving the mic button.
  await installPtyInputProbe(electronApp);
  await installVoiceTranscribeStub(electronApp, CANNED_TEXT);
  await installMicStub(win);
  await installNoClipboardImageStub(electronApp);
  await clearPtyInputLog(electronApp);

  // The MicButton renders only when TerminalPane state is 'ready'. Locate it
  // by aria-label (i18n: voice.start) within the active terminal host. The
  // button is the only one carrying a mic aria-label; match by the host then
  // the absolute-positioned button. Fall back to a broad button query inside
  // the host if i18n label drifts.
  const host = win.locator(`[data-terminal-host][data-active-sid="${sid}"]`).first();
  await host.waitFor({ state: 'visible', timeout: 15_000 });

  const micButton = host.locator('button[aria-label]').filter({ hasNot: win.locator('svg.lucide-loader-2') }).first();
  // The mic button is the absolutely-positioned top-right button inside the
  // host. There may be other buttons; narrow to the one whose title/aria
  // mentions recording or contains the Mic icon. Use a resilient selector:
  // the button has class fragments `top-2 right-2`. Prefer that.
  const micByClass = host.locator('button.absolute.top-2.right-2').first();
  const targetButton = (await micByClass.count()) > 0 ? micByClass : micButton;

  if ((await targetButton.count()) === 0) {
    throw new Error('voice mic button not found in active terminal host');
  }

  // Click 1 → start recording. With the mic stub, start() resolves and the
  // recorder transitions idle → recording.
  await targetButton.click();

  // Wait for the recording state to register (button gets text-red-400 /
  // animate-pulse). Poll the aria-label flipping to the stop label OR the
  // pulse class appearing — but simplest: just give the async start() a beat.
  await sleep(500);

  // Click 2 → stop. This concatenates seeded chunks, resamples, calls
  // window.ccsmVoice.transcribe (our stub → canned text), then
  // pasteIntoActivePty injects the transcript into the pty.
  await targetButton.click();

  // Poll the pty-input log for the canned transcript.
  let entry = null;
  {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const log = await readPtyInputLog(electronApp, sid);
      entry = log
        .filter((e) => typeof e.data === 'string' && e.data.includes(CANNED_TEXT))
        .at(-1) ?? null;
      if (entry) break;
      await sleep(200);
    }
  }

  // Diagnostics if the transcript never arrived.
  if (!entry) {
    const calls = await readTranscribeCalls(electronApp);
    const log = await readPtyInputLog(electronApp, sid);
    throw new Error(
      `voice transcript never reached pty stdin within 15s.\n` +
        `  transcribe calls: ${JSON.stringify(calls)}\n` +
        `  pty input log:    ${JSON.stringify(log)}`,
    );
  }

  // Assert the transcribe stub was actually exercised with a VALID payload —
  // proves the renderer resampled and handed main a well-formed Float32Array
  // (not that we just shoved text into the pty some other way).
  const calls = await readTranscribeCalls(electronApp);
  const validCall = calls.find((c) => c.valid);
  if (!validCall) {
    throw new Error(
      `voice:transcribe was never called with a valid PCM payload. calls=${JSON.stringify(calls)}`,
    );
  }
  console.log(
    `[case=voice-happy-path] transcribe called with ${validCall.length} samples (valid)`,
  );

  // CORE INVARIANT: the injected payload must NOT carry a trailing Enter.
  // The transcript may be bracketed-paste wrapped (\x1b[200~ … \x1b[201~)
  // depending on terminal mode, but it must never end with \r (no auto-submit).
  const data = entry.data;
  console.log(`[case=voice-happy-path] pty stdin payload=${JSON.stringify(data)}`);

  if (data.includes('\r')) {
    throw new Error(
      `voice injection contains a carriage return — would auto-submit the prompt. ` +
        `payload=${JSON.stringify(data)}`,
    );
  }
  // Defence-in-depth: also reject a bare trailing \n outside bracketed paste.
  // Bracketed paste ends with \x1b[201~, so a trailing \n is only a problem
  // when NOT bracketed.
  const bracketed = data.startsWith('\x1b[200~') && data.endsWith('\x1b[201~');
  if (!bracketed && /\n$/.test(data)) {
    throw new Error(
      `voice injection ends with a newline (non-bracketed) — would submit. ` +
        `payload=${JSON.stringify(data)}`,
    );
  }

  // Assert the transcript content survived intact (sans any bracket sentinels).
  const inner = bracketed ? data.slice('\x1b[200~'.length, -'\x1b[201~'.length) : data;
  if (inner !== CANNED_TEXT) {
    throw new Error(
      `voice transcript altered in transit.\n  expected: ${JSON.stringify(CANNED_TEXT)}\n  got:      ${JSON.stringify(inner)} (bracketed=${bracketed})`,
    );
  }
  console.log(
    `[case=voice-happy-path] transcript injected intact, bracketed=${bracketed}, no auto-submit ✓`,
  );
}

// ============================================================================
// Registry
// ============================================================================

const CASE_REGISTRY = [
  { name: 'voice-happy-path', group: 'shared', run: caseVoiceHappyPath },
];

// ============================================================================
// Runner
// ============================================================================

async function main() {
  const { only, skip } = parseArgs(process.argv);
  const selected = CASE_REGISTRY.filter((c) => {
    if (only && !only.includes(c.name)) return false;
    if (skip && skip.includes(c.name)) return false;
    return true;
  });
  if (selected.length === 0) {
    console.error('No cases selected. Available:', CASE_REGISTRY.map((c) => c.name).join(', '));
    process.exit(2);
  }

  if (!existsSync(path.resolve('dist/renderer/index.html'))) {
    console.error('dist/renderer/index.html missing — run `npm run build` first');
    process.exit(2);
  }

  const results = [];
  const harnessStart = Date.now();

  const fakeApi = await startFakeAnthropicApi({ port: 0, verbose: false });
  console.log(`[HARNESS=voice-input] fake Anthropic API at ${fakeApi.url}`);

  let isolated = null;
  let launched = null;
  try {
    isolated = await createIsolatedClaudeDir();
    seedOnboarding(isolated.tempDir);
    launched = await launchCcsmIsolated({
      tempDir: isolated.tempDir,
      env: {
        ANTHROPIC_BASE_URL: fakeApi.url,
        ANTHROPIC_API_KEY: 'fake-ci-key',
      },
    });
    const ctx = { electronApp: launched.electronApp, win: launched.win, tempDir: isolated.tempDir };
    console.log(`\n[HARNESS=voice-input] shared launch ready (tempDir=${isolated.tempDir})`);
    for (const c of selected) {
      const t0 = Date.now();
      console.log(`\n[HARNESS=voice-input] >>> case: ${c.name}`);
      try {
        await c.run(ctx);
        const ms = Date.now() - t0;
        results.push({ name: c.name, ok: true, ms });
        console.log(`[HARNESS=voice-input] <<< PASS ${c.name} (${ms}ms)`);
      } catch (err) {
        const ms = Date.now() - t0;
        results.push({ name: c.name, ok: false, ms, error: String(err?.stack || err) });
        console.error(`[HARNESS=voice-input] <<< FAIL ${c.name} (${ms}ms): ${err?.message || err}`);
      }
    }
  } finally {
    if (launched?.electronApp) try { await launched.electronApp.close(); } catch (_) { /* ignore */ }
    launched?.cleanup?.();
    isolated?.cleanup?.();
    try { await fakeApi.stop(); } catch (_) { /* ignore */ }
  }

  const totalMs = Date.now() - harnessStart;
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log('\n===== HARNESS=voice-input SUMMARY =====');
  for (const r of results) {
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(34)} ${r.ms}ms`);
    if (!r.ok && r.error) console.log(`        ${r.error.split('\n')[0]}`);
  }
  console.log(`  total: ${passed}/${results.length} passed, ${(totalMs / 1000).toFixed(1)}s wall`);
  process.exit(failed === 0 ? 0 : 1);
}

const _entryUrlMain =
  process.argv[1] && new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;
if (_entryUrlMain && import.meta.url === _entryUrlMain) {
  main().catch((err) => {
    console.error('[HARNESS=voice-input] unhandled top-level error:', err?.stack || err);
    process.exit(1);
  });
}
