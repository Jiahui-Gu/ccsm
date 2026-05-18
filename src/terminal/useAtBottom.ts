import { useEffect, useState } from 'react';
import { getTerm } from './xtermSingleton';

// Reads the singleton xterm's buffer position and reports whether the
// viewport is parked at the bottom (i.e. xterm's "follow live output"
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
// programmatic scroll caused by new output) and on `onLineFeed` (covers
// the case where output advances `baseY` without changing `viewportY` —
// e.g. user scrolled up, new lines keep streaming; xterm bumps baseY
// but no scroll event fires). The hook is intentionally tied to the
// module singleton (not parameterised) because there's exactly one
// Terminal across the renderer lifetime.
//
// Returns a stable `atBottom` boolean and a `scrollToBottom` function
// that delegates to xterm's public API.
export type AtBottomState = {
  atBottom: boolean;
  scrollToBottom: () => void;
};

function readAtBottom(): boolean {
  const term = getTerm();
  if (!term) return true; // no terminal yet → don't show the button
  const buf = term.buffer.active;
  return buf.baseY - buf.viewportY <= 1;
}

export function useAtBottom(sessionId: string | null): AtBottomState {
  // Default to `true` so the button starts hidden and only appears once
  // the user has actually scrolled away. Initial mount may race with the
  // singleton being constructed; we re-poll on the first effect tick.
  const [atBottom, setAtBottom] = useState<boolean>(true);

  useEffect(() => {
    const term = getTerm();
    if (!term) {
      // Singleton not yet constructed (StrictMode double-invoke race).
      // Re-check on next frame; if still missing, give up — the host
      // hook (`useXtermSingleton`) will trigger another render once
      // it's ready.
      const id = requestAnimationFrame(() => setAtBottom(readAtBottom()));
      return () => cancelAnimationFrame(id);
    }

    const recompute = (): void => setAtBottom(readAtBottom());
    // Session swap: re-read immediately. `term.reset()` happens in
    // `usePtyAttach` on attach; after reset, baseY/viewportY are both 0
    // → atBottom = true (button hidden). This effect re-runs because
    // `sessionId` is in the deps array, so we capture the post-reset
    // state cleanly.
    recompute();

    const scrollDisposable = term.onScroll(recompute);
    const lineFeedDisposable = term.onLineFeed(recompute);

    return () => {
      scrollDisposable.dispose();
      lineFeedDisposable.dispose();
    };
  }, [sessionId]);

  return {
    atBottom,
    scrollToBottom: () => {
      const term = getTerm();
      if (!term) return;
      // xterm's public API: scrolls viewport such that `viewportY === baseY`,
      // which restores the "follow live output" behaviour automatically.
      term.scrollToBottom();
    },
  };
}
