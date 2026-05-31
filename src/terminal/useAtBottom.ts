import { useEffect, useState } from 'react';
import { getTopShell } from './shellRegistry';

// Reads the active warm-entry xterm's buffer position and reports whether
// the viewport is parked at the bottom (i.e. xterm's "follow live output"
// state is engaged). Used by the floating jump-to-bottom button to know
// when to reveal itself.
//
// Detection rule:
//   atBottom = (baseY - viewportY) <= 1
// xterm advances `baseY` as new lines are written into the scrollback;
// `viewportY` only moves when the viewport itself scrolls. So when the
// user scrolls up, `viewportY` < `baseY` and the gap is the # of lines
// they're behind. A 1-line tolerance covers rounding when the renderer
// is mid-frame between scrolls (otherwise we'd flicker the button on
// every burst of output even though the user is effectively at bottom).
//
// We re-read on `onScroll` (xterm fires this for both user scroll and
// programmatic scroll caused by new output), on `onLineFeed` (covers
// the case where output advances `baseY` without changing `viewportY` —
// e.g. user scrolled up, new lines keep streaming; xterm bumps baseY but
// no scroll event fires), and on `onRender` (covers wheel scroll, which
// moves `viewportY` but fires no `onScroll` — xterm passes
// `suppressScrollEvent=true` on its wheel path). The hook reads the
// registry's top shell (z-stack path — see `shellRegistry.ts` /
// `usePtyAttachShell.ts`) so the listeners attach to whichever Terminal
// is currently in the foreground.
//
// Returns a stable `atBottom` boolean and a `scrollToBottom` function
// that delegates to xterm's public API.
export type AtBottomState = {
  atBottom: boolean;
  scrollToBottom: () => void;
};

function readAtBottom(): boolean {
  const term = getTopShell()?.term;
  if (!term) return true;
  const buf = term.buffer.active;
  return buf.baseY - buf.viewportY <= 1;
}

export function useAtBottom(sessionId: string | null): AtBottomState {
  const [atBottom, setAtBottom] = useState<boolean>(true);

  useEffect(() => {
    const term = getTopShell()?.term;
    if (!term) {
      const id = requestAnimationFrame(() => setAtBottom(readAtBottom()));
      return () => cancelAnimationFrame(id);
    }
    const recompute = (): void => setAtBottom(readAtBottom());
    recompute();
    const scrollDisposable = term.onScroll(recompute);
    const lineFeedDisposable = term.onLineFeed(recompute);
    // Wheel scroll moves viewportY without firing onScroll (xterm passes
    // suppressScrollEvent=true on the wheel path), so the button would miss
    // a wheel-up off the bottom. onRender fires on that repaint (#82).
    const renderDisposable = term.onRender(recompute);
    return () => {
      scrollDisposable.dispose();
      lineFeedDisposable.dispose();
      renderDisposable.dispose();
    };
  }, [sessionId]);

  return {
    atBottom,
    scrollToBottom: () => {
      const term = getTopShell()?.term;
      if (!term) return;
      term.scrollToBottom();
    },
  };
}
