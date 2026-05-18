// Paste-double-fire diagnostic probe.
//
// Question this answers: when Ctrl+V is pressed in the terminal pane, which
// code paths reach `window.ccsmPty.input`? The user reports pasting "hello"
// produces "hellohello" in the PTY — exactly two calls. We need to know
// WHICH two, because the fix in xtermSingleton.ts is supposed to converge
// every paste source onto a single `ccsmPty.input(sid, text)` call.
//
// Strategy:
//   1. Launch ccsm isolated + seed a session, wait for terminal ready.
//   2. In the renderer, monkey-patch `window.ccsmPty.input` to count calls
//      and capture each caller's stack — non-destructive: the original is
//      still invoked so the PTY behaves normally.
//   3. Stub `window.ccsmPty.clipboard.readText` to deterministically return
//      a known sentinel string ("ccsm-paste-probe-hello"). This decouples
//      the test from the OS clipboard.
//   4. Trigger paste via TWO routes:
//        (a) Direct keyboard event on the xterm element via Playwright's
//            keyboard API. This drives our `attachCustomKeyEventHandler`
//            Ctrl+V branch in xtermSingleton.ts — that's path P1.
//        (b) Synthesize a real DOM `ClipboardEvent` on xterm's helper
//            textarea. This is what the browser's native paste-event
//            dispatch looks like — that's path P2 (host capture listener)
//            and P3 (xterm built-in paste pipeline).
//      We run both serially so we can attribute calls to a route.
//   5. Print the call log: count, text content per call, and a few frames
//      of stack so we can see whether the call came from our keydown
//      handler, our host capture listener, the xterm built-in pipeline,
//      or anywhere else.
//
// Why this is enough to diagnose: if (a) alone causes >1 call, the bug is
// inside our keydown path (which is supposed to inject once + set a flag
// that suppresses the follow-up paste event). If (b) alone causes >1 call,
// the bug is that our host capture listener isn't stopping xterm's own
// listeners on textarea/element. Either way we'll see WHERE the duplicate
// fires come from in the stack traces.

import {
  createIsolatedClaudeDir,
  launchCcsmIsolated,
  seedSession,
  waitForTerminalReady,
  dismissFirstRunModals,
} from './probe-utils-real-cli.mjs';

const SENTINEL = 'ccsm-paste-probe-hello';

async function main() {
  const { tempDir } = await createIsolatedClaudeDir();
  console.log('[probe] tempDir=', tempDir);

  const { electronApp, win } = await launchCcsmIsolated({ tempDir });

  try {
    // Wait for claude-availability probe + mount.
    await win.waitForFunction(
      () => !document.querySelector('[data-testid="claude-availability-probing"]'),
      null,
      { timeout: 30000 },
    );

    const { sid } = await seedSession(win, { name: 'paste-probe', cwd: tempDir });
    if (!sid) throw new Error('seedSession returned empty sid');
    console.log('[probe] seeded sid=', sid);

    await new Promise((r) => setTimeout(r, 4000));
    await waitForTerminalReady(win, sid, { timeout: 60000 });
    await dismissFirstRunModals(win);

    // Install diagnostics. `window.ccsmPty` is frozen by contextBridge,
    // so we cannot reliably monkey-patch ccsmPty.input from the renderer.
    // Instead instrument the main-process IPC handler — same call site,
    // strictly above the preload boundary, robust against frozen objects.
    await electronApp.evaluate(({ ipcMain }) => {
      const g = globalThis;
      g.__pasteProbeCalls = [];
      // ipcMain stores invoke handlers in an internal map. The public API
      // is removeHandler + handle, but we don't have a reference to the
      // original handler. We mutate the internal map directly to wrap it.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const internal = ipcMain;
      const handlers = internal._invokeHandlers;
      if (!handlers || !handlers.get('pty:input')) {
        g.__pasteProbeError = 'no existing pty:input handler';
        return;
      }
      const orig = handlers.get('pty:input');
      handlers.set('pty:input', async (event, ...args) => {
        const [sid, data] = args;
        g.__pasteProbeCalls.push({ sid, data, ts: Date.now() });
        return orig(event, ...args);
      });
      g.__pasteProbeReady = true;
    });
    const ipcReady = await electronApp.evaluate(() => ({
      ready: globalThis.__pasteProbeReady === true,
      error: globalThis.__pasteProbeError || null,
    }));
    console.log('[probe] ipcMain patch:', ipcReady);
    if (!ipcReady.ready) throw new Error('failed to patch ipcMain.handle');

    // Try stubbing the renderer-side readText too, in case it's mutable.
    const stubMode = await win.evaluate((sentinel) => {
      try {
        window.ccsmPty.clipboard.readText = () => sentinel;
        return 'direct-ok';
      } catch (_) {
        try {
          Object.defineProperty(window.ccsmPty.clipboard, 'readText', {
            value: () => sentinel,
            configurable: true,
          });
          return 'defineProperty-ok';
        } catch (_) {
          return 'failed-frozen';
        }
      }
    }, SENTINEL);
    console.log('[probe] readText stub:', stubMode);

    // Sanity.
    const sanity = await win.evaluate(() => ({
      hasTerm: !!window.__ccsmTerm,
      hasXterm: !!document.querySelector('.xterm'),
      hasHelper: !!document.querySelector('.xterm-helper-textarea'),
    }));
    console.log('[probe] sanity:', sanity);

    const resetProbe = () => electronApp.evaluate(() => {
      globalThis.__pasteProbeCalls.length = 0;
    });
    const readProbe = () =>
      electronApp.evaluate(() => globalThis.__pasteProbeCalls.slice());

    // Write SENTINEL to the OS clipboard so the browser's native paste
    // pipeline (event.clipboardData) sees the same string as our stubbed
    // ccsmPty.clipboard.readText. Use Electron's main-process clipboard
    // API since the renderer's navigator.clipboard requires user-activation.
    await electronApp.evaluate(({ clipboard }, text) => {
      clipboard.writeText(text);
    }, SENTINEL);
    console.log('[probe] wrote SENTINEL to OS clipboard');

    // --- Route A: synthesize Ctrl+V keydown directly on the xterm element.
    //
    // We dispatch a real KeyboardEvent on the xterm helper textarea, which
    // is what xterm's internal listeners are attached to. xterm forwards
    // keydown to its `_customKeyEventHandler`, exercising our P1 branch in
    // xtermSingleton.ts. Note: this is a synthetic event — it does NOT
    // trigger the browser's native paste pipeline (which only fires for
    // real OS clipboard operations), so it isolates P1 cleanly.
    console.log('\n[probe] === Route A: Playwright keyboard Ctrl+V on focused textarea ===');
    await resetProbe();
    await win.evaluate(() => {
      const ta = document.querySelector('.xterm-helper-textarea');
      if (ta) ta.focus();
    });
    await win.keyboard.down('Control');
    await win.keyboard.press('KeyV');
    await win.keyboard.up('Control');
    await new Promise((r) => setTimeout(r, 800));
    const routeA = await readProbe();
    console.log(`[probe] route A: pty:input invoked ${routeA.length} time(s):`);
    routeA.forEach((c, i) => {
      console.log(`  [${i}] data=${JSON.stringify(c.data).slice(0, 100)}`);
    });

    console.log('\n[probe] === Route B: synthetic paste ClipboardEvent ===');
    await resetProbe();
    await win.evaluate((sentinel) => {
      const xtermEl = document.querySelector('.xterm');
      if (!xtermEl) throw new Error('.xterm not found');
      const target = document.querySelector('.xterm-helper-textarea') || xtermEl;
      const dt = new DataTransfer();
      dt.setData('text/plain', sentinel);
      const evt = new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      target.dispatchEvent(evt);
    }, SENTINEL);
    await new Promise((r) => setTimeout(r, 800));
    const routeB = await readProbe();
    console.log(`[probe] route B: pty:input invoked ${routeB.length} time(s):`);
    routeB.forEach((c, i) => {
      console.log(`  [${i}] data=${JSON.stringify(c.data).slice(0, 100)}`);
    });

    console.log('\n[probe] === Route C: combined keydown + paste event in same tick ===');
    await resetProbe();
    await win.evaluate((sentinel) => {
      const ta = document.querySelector('.xterm-helper-textarea');
      if (!ta) throw new Error('xterm-helper-textarea not found');
      ta.focus();
      ta.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'v', code: 'KeyV', ctrlKey: true, bubbles: true, cancelable: true,
      }));
      const dt = new DataTransfer();
      dt.setData('text/plain', sentinel);
      ta.dispatchEvent(new ClipboardEvent('paste', {
        clipboardData: dt, bubbles: true, cancelable: true,
      }));
    }, SENTINEL);
    await new Promise((r) => setTimeout(r, 800));
    const routeC = await readProbe();
    console.log(`[probe] route C: pty:input invoked ${routeC.length} time(s):`);
    routeC.forEach((c, i) => {
      console.log(`  [${i}] data=${JSON.stringify(c.data).slice(0, 100)}`);
    });

    console.log('\n[probe] === summary ===');
    console.log(`route A (real keyboard): ${routeA.length} call(s)`);
    console.log(`route B (paste-event):   ${routeB.length} call(s)`);
    console.log(`route C (combined):      ${routeC.length} call(s)`);
  } finally {
    try { await electronApp.close(); } catch (_) { /* ignore */ }
  }
}

main().catch((e) => {
  console.error('[probe] failed:', e);
  process.exit(1);
});
