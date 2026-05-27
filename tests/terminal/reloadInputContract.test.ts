// Regression test for Task #79b — reload-input wiring contract.
//
// Bug report: after `reloadSession`, keystrokes typed into xterm are
// dropped — claude (in the freshly-spawned PTY) never sees them. The
// renderer-side reload flow is term.reset() in-place + cold-start suffix;
// the suffix's `if (!shell.inputWired)` guard skips re-wiring onData.
//
// PR #1403 reviewer challenged hypothesis H1 ("term.reset() invalidates
// the onData subscription") with the xterm.js docs claim that reset does
// NOT dispose attached event listeners. This test EMPIRICALLY validates
// that contract end-to-end using a real (non-mocked) xterm Terminal:
//
//   1. Construct a real Terminal, term.open() against a real DOM node.
//   2. Wire term.onData → recorder (mirrors production).
//   3. Fire a keystroke via coreService.triggerDataEvent — recorder sees it.
//   4. Simulate the full reload flow: term.reset() (resetShellForReload),
//      resize, term.reset() again (inside runColdStartSuffix), write a
//      "snapshot" string, fire another keystroke.
//   5. Assert the recorder STILL sees the post-reload keystroke.
//
// If this test ever fails, the input-wiring assumption in
// usePtyAttachShell.ts (the `inputWired` guard) is broken and reload
// will silently drop keystrokes — exactly the user-reported bug. The
// fix is to drop the guard and re-wire onData on every reload.
//
// Why this test lives here: it's the ONLY place we exercise a real xterm
// instance (the shellRegistry tests vi.mock the Terminal constructor). It
// runs in jsdom under vitest like the rest of the suite.

import { describe, it, expect, beforeAll } from 'vitest';

// Shims xterm needs in jsdom that vitest's default env doesn't provide.
beforeAll(() => {
  if (typeof window !== 'undefined') {
    const w = window as unknown as Record<string, unknown>;
    if (!w.matchMedia) {
      w.matchMedia = () => ({
        matches: false,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
      });
    }
    if (typeof window.requestAnimationFrame !== 'function') {
      window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
        setTimeout(() => cb(performance.now()), 16)) as typeof window.requestAnimationFrame;
      window.cancelAnimationFrame = (id: number) => clearTimeout(id as unknown as NodeJS.Timeout);
    }
    if (typeof HTMLCanvasElement !== 'undefined') {
      // xterm tries to construct a canvas renderer; in jsdom getContext
      // returns null which xterm handles by falling back to DOM-only
      // rendering. We just need it to not throw.
      const proto = HTMLCanvasElement.prototype as unknown as { getContext?: () => null };
      if (!proto.getContext) proto.getContext = () => null;
    }
  }
});

describe('xterm reload-input contract (Task #79b)', () => {
  it('term.onData listener survives term.reset() across a full reload-style flow', async () => {
    const xt = await import('@xterm/xterm');
    const Terminal = xt.Terminal;
    const term = new Terminal();
    const host = document.createElement('div');
    document.body.appendChild(host);
    term.open(host);

    // Mirror production wiring: onData → recorded list (production: → ccsmPty.input).
    const recorded: string[] = [];
    term.onData((data: string) => {
      recorded.push(data);
    });

    // Access coreService to fire keystrokes the way xterm's internal
    // keydown handler does. Real production keystrokes from the helper
    // textarea route through this same triggerDataEvent path.
    const core = (term as unknown as {
      _core: {
        coreService?: { triggerDataEvent: (data: string, wasUserInput: boolean) => void };
        _coreService?: { triggerDataEvent: (data: string, wasUserInput: boolean) => void };
      };
    })._core;
    const cs = core.coreService ?? core._coreService;
    expect(cs).toBeDefined();
    if (!cs) throw new Error('coreService unreachable');

    // Cold-start keystroke baseline.
    cs.triggerDataEvent('a', true);
    expect(recorded).toEqual(['a']);

    // Simulate the full reload flow that usePtyAttachShell drives:
    // resetShellForReload calls term.reset(); runColdStartSuffix then
    // calls term.resize + a SECOND term.reset() + writes the snapshot.
    term.reset();
    term.resize(80, 24);
    term.reset();
    term.write('claude bootstrap snapshot\r\n');

    // Post-reload keystroke must still flow.
    cs.triggerDataEvent('\r', true); // Enter — the actual key the bug report mentions
    cs.triggerDataEvent('1', true);  // trust-folder option

    expect(recorded).toEqual(['a', '\r', '1']);

    // Cleanup. xterm queues raf callbacks during reset+resize that resolve
    // viewport dimensions; jsdom's HTMLCanvasElement.getContext returns
    // null which makes those late callbacks log a dimensions error. We
    // drain the rafs while term is still alive, then dispose.
    await new Promise((resolve) => setTimeout(resolve, 50));
    try {
      term.dispose();
    } catch {
      /* best-effort */
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    host.remove();
  });
});
