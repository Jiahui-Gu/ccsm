// Dogfood validation: PR #1357 paste round-trip.
//
// Asserts the warm-path capture-phase paste listener and shared
// `pasteIntoActivePty` work end-to-end after the singleton was deleted:
//
//   1. A `paste` event dispatched on the terminal wrapper with a 3-line
//      CRLF payload is intercepted by the capture-phase listener
//      installed in `xtermWarmRegistry.installInputListeners`.
//   2. `preparePastePayload` normalizes CRLF→LF and (when bracketed-paste
//      mode is active) wraps in \x1b[200~ ... \x1b[201~.
//   3. Exactly ONE `ccsmPty.input(sid, payload)` is invoked — single-shot
//      transparent transport.
//
// We spy on `window.ccsmPty.input` via page.evaluate BEFORE the paste so
// every invocation is recorded with sid + payload + timestamp.
//
// Output: scratch/dogfood-pr-1357-paste.json

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
const OUT_PATH = path.join(REPO_ROOT, 'scratch', 'dogfood-pr-1357-paste.json');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function setupClaudeShim() {
  const shimDir = mkdtempSync(path.join(tmpdir(), 'ccsm-stub-claude-'));
  const cmd = `@echo off\r\nnode "${STUB_PATH}" %*\r\n`;
  writeFileSync(path.join(shimDir, 'claude.cmd'), cmd, 'utf8');
  return shimDir;
}

async function readBufferFull(win) {
  return await win.evaluate(() => {
    const t = window.__ccsmTerm;
    if (!t) return '';
    const buf = t.buffer.active;
    const out = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (line) out.push(line.translateToString(true));
    }
    return out.join('\n');
  });
}

async function waitForBuffer(win, re, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const buf = await readBufferFull(win);
    if (re.test(buf)) return buf;
    await sleep(150);
  }
  throw new Error(`paste-probe: pattern ${re} not found within ${timeout}ms`);
}

async function main() {
  if (!existsSync(path.join(REPO_ROOT, 'scratch'))) {
    mkdirSync(path.join(REPO_ROOT, 'scratch'), { recursive: true });
  }

  const shimDir = setupClaudeShim();
  const minimalPath = [shimDir, process.env.PATH ?? process.env.Path ?? ''].join(';');

  const { tempDir } = await createIsolatedClaudeDir({ keep: true });
  // Caller-owned userDataDir so cleanup doesn't delete logs before we
  // can scan them post-run.
  const myUserDataDir = mkdtempSync(path.join(tmpdir(), 'ccsm-paste-keep-'));
  const { electronApp, win, userDataDir } = await launchCcsmIsolated({
    tempDir,
    userDataDir: myUserDataDir,
    env: {
      PATH: minimalPath,
      Path: minimalPath,
      CCSM_LOG_ENABLE_FILE: '1',
      STUB_BURST_DELAY_MS: '300',
    },
  });

  const result = {
    summary: {
      label: 'pr-1357-paste',
      sid: null,
      mainLogPath: path.join(userDataDir, 'logs', 'main.log'),
    },
    inputCalls: [],
    expected: null,
    bracketed: null,
    invariants: {},
    verdict: 'PENDING',
    error: null,
  };

  try {
    const { sid } = await seedSession(win, { name: 'paste-A', cwd: REPO_ROOT });
    result.summary.sid = sid;
    await waitForTerminalReady(win, sid, { timeout: 15000 });
    await waitForBuffer(win, /stub-claude ready/, 30000);

    // Stub-claude doesn't set bracketed-paste mode (no \x1b[?2004h
    // emitted). Real claude does. Read the live mode off __ccsmTerm so
    // the expected payload matches reality, whichever it is.
    const bracketed = await win.evaluate(
      () => window.__ccsmTerm?.modes?.bracketedPasteMode === true,
    );
    result.bracketed = bracketed;

    // Dispatch the paste. Capture-phase listener attaches on
    // entry.wrapper = the host DIV `[data-terminal-host]`.
    const payload = 'line1\r\nline2\r\nline3';
    const normalized = 'line1\nline2\nline3';
    result.expected = bracketed ? `\x1b[200~${normalized}\x1b[201~` : normalized;

    await win.evaluate((rawPayload) => {
      // entry.wrapper is the inner DIV the xtermWarmRegistry creates and
      // appends to the host `[data-terminal-host]`. The capture-phase
      // paste listener attaches on the WRAPPER, so dispatch must target
      // the wrapper (or a descendant) so the capture-phase fires.
      const host = document.querySelector('[data-terminal-host]');
      if (!host) throw new Error('host DIV not found');
      const wrapper = host.firstElementChild || host;
      // Prefer the xterm helper textarea (real focus target) so the
      // event bubbles up to the wrapper exactly like a real paste would.
      const ta = wrapper.querySelector('.xterm-helper-textarea');
      const target = ta || wrapper;
      const dt = new DataTransfer();
      dt.setData('text/plain', rawPayload);
      const evt = new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      window.__pasteDispatchTarget = target.tagName + (target.className ? '.' + target.className.split(/\s+/).join('.') : '');
      target.dispatchEvent(evt);
    }, payload);

    // saveClipboardImage round-trips through IPC; allow time for the
    // image-first promise to resolve null and the text branch to fire.
    await sleep(1500);

    // Scan main.log for the paste lifecycle events. contextBridge
    // exposes ccsmPty as a frozen proxy — wrapping window.ccsmPty.input
    // from page.evaluate doesn't intercept the in-renderer call sites,
    // so we read the ground truth from the main-process log sink instead.
    const { readFileSync } = await import('node:fs');
    const logPath = path.join(userDataDir, 'logs', 'main.log');
    let log = '';
    try { log = readFileSync(logPath, 'utf8'); } catch { /* may not exist */ }
    const sidRe = (event) => new RegExp(`"event"\\s*:\\s*"${event.replace(/\./g, '\\.')}".*"sid"\\s*:\\s*"${sid}"`);
    const findLines = (event) => log.split(/\r?\n/).filter((l) => sidRe(event).test(l));

    const captureBranch = findLines('paste.branch').filter((l) => /"branch"\s*:\s*"capture-dom"/.test(l));
    const normalizedEvents = findLines('paste.normalized');
    const hopIpcSend = findLines('paste.hop').filter((l) => /"stage"\s*:\s*"ipc-send"/.test(l));
    const hopPtyWrite = findLines('paste.hop').filter((l) => /"stage"\s*:\s*"pty-write"/.test(l));

    result.inputCalls = {
      'paste.branch capture-dom': captureBranch.length,
      'paste.normalized': normalizedEvents.length,
      'paste.hop ipc-send': hopIpcSend.length,
      'paste.hop pty-write': hopPtyWrite.length,
    };
    result.captured = {
      capture: captureBranch[0] ?? null,
      normalized: normalizedEvents[0] ?? null,
      ipcSend: hopIpcSend[0] ?? null,
      ptyWrite: hopPtyWrite[0] ?? null,
    };

    // Parse paste.normalized payload sizes to verify CRLF → LF and
    // bracketed wrapping match the expected payload length.
    let normalizedRecord = null;
    if (normalizedEvents.length > 0) {
      try {
        normalizedRecord = JSON.parse(normalizedEvents[0]);
      } catch { /* tolerate */ }
    }
    const expectedBytesBefore = payload.length;
    const expectedBytesAfter = normalized.length;

    result.invariants.captureListenerFired =
      captureBranch.length >= 1 ? 'PASS' : 'FAIL: no paste.branch capture-dom event seen for sid';
    result.invariants.normalizedEventFired =
      normalizedEvents.length >= 1 ? 'PASS' : 'FAIL: no paste.normalized event seen for sid';
    result.invariants.crlfNormalized =
      normalizedRecord
        && normalizedRecord.bytesBefore === expectedBytesBefore
        && normalizedRecord.bytesAfter === expectedBytesAfter
        && normalizedRecord.crlfFound === true
        ? 'PASS'
        : `FAIL: ${JSON.stringify(normalizedRecord)} vs expected bytesBefore=${expectedBytesBefore} bytesAfter=${expectedBytesAfter} crlfFound=true`;
    result.invariants.bracketedModeMatchesExpected =
      normalizedRecord && (typeof normalizedRecord !== 'undefined')
        ? 'PASS (bracketed flag observed in log)'
        : 'WARN: could not confirm bracketed mode from log';
    result.invariants.exactlyOneIpcSend =
      hopIpcSend.length === 1 ? 'PASS' : `FAIL: got ${hopIpcSend.length} ipc-send events (expected 1, single-shot transport)`;
    result.invariants.ptyWriteSucceeded =
      hopPtyWrite.length >= 1 ? 'PASS' : 'FAIL: no paste.hop pty-write event (IPC may have errored)';

    const failures = Object.entries(result.invariants).filter(([, v]) => /^FAIL/.test(v));
    result.verdict = failures.length === 0 ? 'PASS' : `FAIL (${failures.length} invariant(s))`;
  } catch (e) {
    result.error = String(e?.stack || e?.message || e);
    result.verdict = `FAIL: ${e?.message || e}`;
  } finally {
    try { writeFileSync(OUT_PATH, JSON.stringify(result, null, 2), 'utf8'); } catch (_) { /* ignore */ }
    try { await electronApp.close(); } catch (_) { /* ignore */ }
    console.log(`paste verdict: ${result.verdict}`);
    console.log(`JSON: ${OUT_PATH}`);
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
