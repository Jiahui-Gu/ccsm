// Regression tests for PR #1385 / bug #66 — warm-session-switch leaves
// the scrollbar thumb at the top while the canvas paints the user's
// pre-hide rows.
//
// Root cause (re-diagnosed after the first fix failed dogfood):
//   `term.scrollToLine(line)` is `scrollLines(line - ydisp)`, and
//   `scrollLines(0)` returns early without firing `onScroll`
//   (CoreTerminal.ts:219 + BufferService.ts:128). Across the offscreen
//   hide/show detour the registry preserves `buffer.ydisp` at
//   savedViewportY — the canvas paints correctly — so calling
//   `scrollToLine(savedViewportY)` after fit+focus does NOTHING:
//
//     - no `onScroll` fire
//     - no `Viewport.syncScrollArea` → `_innerRefresh`
//     - no `.xterm-viewport.scrollTop = ydisp * rowHeight` write
//
//   The DOM scrollbar thumb stays at 0 (where webkit left it when the
//   wrapper was offscreen) → exactly the reported symptom.
//
// The fix lives in `restoreWarmScrollPosition` (xtermWarmRegistry.ts):
// force a non-zero scroll diff via `scrollToBottom()` + `scrollToLine
// (target)` so `onScroll` fires, which triggers Viewport's RAF to
// re-sync the DOM scrollTop from the (still-correct) ydisp.
//
// We use REAL `@xterm/xterm` Terminal here (no module mock) — the bug
// is in xterm's internal scrollLines early-return, so testing against a
// mock that just records `scrollToLine` arguments (as the existing
// usePtyAttachWarm.race.test.tsx does) cannot catch it. That test
// passing while the actual bug shipped is precisely how we got here.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { restoreWarmScrollPosition } from '../../src/terminal/xtermWarmRegistry';

describe('warm-show scrollbar restore (bug #66)', () => {
  let host: HTMLDivElement;
  let term: Terminal;
  let scrollFireCount: number;

  beforeEach(() => {
    // xterm's CoreBrowserService probes matchMedia on the host's
    // ownerDocument.defaultView for DPR tracking. jsdom doesn't ship
    // matchMedia — stub a minimal MediaQueryList on every window we can
    // reach so Terminal construction doesn't throw.
    const stubMatchMedia = (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
      onchange: null,
    });
    for (const w of [window, document.defaultView].filter(Boolean) as Window[]) {
      if (typeof (w as unknown as { matchMedia?: unknown }).matchMedia !== 'function') {
        Object.defineProperty(w, 'matchMedia', {
          configurable: true,
          writable: true,
          value: stubMatchMedia,
        });
      }
    }

    host = document.createElement('div');
    host.style.width = '800px';
    host.style.height = '480px';
    document.body.appendChild(host);
    term = new Terminal({ scrollback: 1000, rows: 24, cols: 80 });
    term.open(host);
    scrollFireCount = 0;
    term.onScroll(() => {
      scrollFireCount += 1;
    });
  });

  afterEach(() => {
    try {
      term.dispose();
    } catch {
      /* ignore */
    }
    document.body.removeChild(host);
  });

  // Helper: drive enough lines into the buffer that ybase > 0, then park
  // ydisp at a mid-buffer row. Returns a promise — `term.write()` is
  // async (parser runs on a microtask).
  async function seedAndScrollUp(targetYdisp: number): Promise<{ ybase: number; ydisp: number }> {
    const chunk = Array.from({ length: 300 }, (_, i) => `line ${i}\r\n`).join('');
    await new Promise<void>((resolve) => {
      term.write(chunk, () => resolve());
    });
    term.scrollToLine(targetYdisp);
    return {
      ybase: term.buffer.active.baseY,
      ydisp: term.buffer.active.viewportY,
    };
  }

  // RED baseline — proves the bug. With the previous fix
  // (`term.scrollToLine(savedViewportY)`) the call is a no-op when ydisp
  // already equals savedViewportY (which is exactly the warm-show state
  // post-detour), and `onScroll` doesn't fire. Without an onScroll fire
  // the DOM scrollbar thumb is never synced — the reported symptom.
  it('REGRESSION BASELINE: `term.scrollToLine(savedViewportY)` is a no-op (does NOT fire onScroll) when ydisp already equals savedViewportY', async () => {
    const { ydisp: savedViewportY } = await seedAndScrollUp(120);
    expect(savedViewportY).toBe(120);
    expect(term.buffer.active.viewportY).toBe(120);

    // Reset fire counter — count ONLY the supposed restore call.
    scrollFireCount = 0;
    term.scrollToLine(savedViewportY);

    // The bug: zero fires means Viewport never re-syncs DOM scrollTop.
    expect(scrollFireCount).toBe(0);
  });

  // GREEN — the corrected helper FORCES an onScroll fire so Viewport
  // re-syncs the DOM scrollbar thumb, AND lands ydisp at savedViewportY
  // (canvas content unchanged).
  it('FIX: `restoreWarmScrollPosition(term, savedViewportY)` fires onScroll AND keeps ydisp at savedViewportY', async () => {
    const { ydisp: savedViewportY, ybase } = await seedAndScrollUp(120);
    expect(savedViewportY).toBe(120);
    expect(ybase).toBeGreaterThan(savedViewportY);

    scrollFireCount = 0;
    restoreWarmScrollPosition(term, savedViewportY);

    expect(term.buffer.active.viewportY).toBe(savedViewportY);
    expect(scrollFireCount).toBeGreaterThanOrEqual(1);
  });

  it('bottom-pin case: savedViewportY >= baseY calls scrollToBottom and leaves ydisp at ybase', async () => {
    // Seed and stay pinned to live tail (no scrollToLine call → ydisp
    // sticks at ybase). Save the pre-restore state.
    const chunk = Array.from({ length: 300 }, (_, i) => `line ${i}\r\n`).join('');
    await new Promise<void>((resolve) => {
      term.write(chunk, () => resolve());
    });
    const savedViewportY = term.buffer.active.viewportY; // === baseY
    const ybase = term.buffer.active.baseY;
    expect(savedViewportY).toBe(ybase);

    restoreWarmScrollPosition(term, savedViewportY);
    expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY);
  });

  it('shrunk-buffer case: savedViewportY > current baseY pins to bottom', async () => {
    // Simulate "scrollback purge between hide and show" by saving a
    // viewportY that's deliberately higher than the current baseY.
    await seedAndScrollUp(50);
    const savedViewportY = term.buffer.active.baseY + 100; // future-y row
    restoreWarmScrollPosition(term, savedViewportY);
    expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY);
  });

  it('null savedViewportY is a no-op (first show, never hidden)', async () => {
    await seedAndScrollUp(120);
    const before = term.buffer.active.viewportY;
    scrollFireCount = 0;
    restoreWarmScrollPosition(term, null);
    expect(term.buffer.active.viewportY).toBe(before);
    expect(scrollFireCount).toBe(0);
  });
});
