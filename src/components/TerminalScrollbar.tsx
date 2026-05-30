import { useCallback, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { useTerminalScroll } from '../terminal/useTerminalScroll';

// Self-drawn terminal scrollbar. Replaces xterm's native `.xterm-viewport`
// scrollbar (hidden in global.css) so the thumb position is a pure
// projection of xterm's buffer state and can never desync from the
// rendered content (see `useTerminalScroll` + the scrollbar architecture
// spec).
//
// Layout: absolutely positioned strip on the right edge of the TerminalPane
// host. `pointer-events: none` on the container so the strip never blocks
// the terminal text; only the track and thumb opt back in. The track
// captures clicks in its empty space (page up/down); the thumb is dragged
// with pointer-capture.
//
// Width matches the app's native 10px scrollbar (global.css) so swapping
// implementations is visually seamless. Colors reuse the shared border
// tokens, same as the native `::-webkit-scrollbar-thumb`.

const SCROLLBAR_WIDTH = 10;

export function TerminalScrollbar({
  sessionId,
  trackHeight,
}: {
  sessionId: string;
  trackHeight: number;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  // Drag bookkeeping: offset of the pointer within the thumb at grab time,
  // so the thumb doesn't jump its top to the cursor on grab.
  const dragGrabOffsetRef = useRef<number>(0);

  const { visible, thumbTop, thumbHeight, dragTo, pageBy } = useTerminalScroll(
    sessionId,
    trackHeight,
  );

  const onThumbPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const track = trackRef.current;
      if (!track) return;
      const trackTop = track.getBoundingClientRect().top;
      dragGrabOffsetRef.current = e.clientY - trackTop - thumbTop;
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [thumbTop],
  );

  const onThumbPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
      const track = trackRef.current;
      if (!track) return;
      const trackTop = track.getBoundingClientRect().top;
      const nextThumbTop = e.clientY - trackTop - dragGrabOffsetRef.current;
      dragTo(nextThumbTop);
    },
    [dragTo],
  );

  const onThumbPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    },
    [],
  );

  const onTrackPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      // Click in the empty track (not on the thumb) → page towards the click.
      const track = trackRef.current;
      if (!track) return;
      const clickY = e.clientY - track.getBoundingClientRect().top;
      pageBy(clickY < thumbTop ? -1 : 1);
    },
    [pageBy, thumbTop],
  );

  if (!visible) return null;

  return (
    <div
      ref={trackRef}
      data-terminal-scrollbar
      onPointerDown={onTrackPointerDown}
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        width: SCROLLBAR_WIDTH,
        // Container itself is transparent and only the thumb is a hit
        // target by default; the track opts into pointer events so empty-
        // space clicks page, but it sits flush to the right edge where no
        // terminal glyph cell is, so it doesn't steal terminal interaction.
        pointerEvents: 'auto',
        zIndex: 10,
      }}
    >
      <div
        data-terminal-scrollbar-thumb
        onPointerDown={onThumbPointerDown}
        onPointerMove={onThumbPointerMove}
        onPointerUp={onThumbPointerUp}
        onPointerCancel={onThumbPointerUp}
        style={{
          position: 'absolute',
          top: thumbTop,
          right: 2,
          width: SCROLLBAR_WIDTH - 4,
          height: thumbHeight,
          borderRadius: 99,
          background: 'var(--color-border-subtle)',
          cursor: 'default',
          transition: 'background-color 150ms cubic-bezier(0.32, 0.72, 0, 1)',
        }}
        onPointerEnter={(e) => {
          e.currentTarget.style.background = 'var(--color-border-default)';
        }}
        onPointerLeave={(e) => {
          e.currentTarget.style.background = 'var(--color-border-subtle)';
        }}
      />
    </div>
  );
}

export default TerminalScrollbar;
