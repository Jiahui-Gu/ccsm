import { useCallback, useEffect, useRef, type MouseEvent } from 'react';
import '@xterm/xterm/css/xterm.css';
import { useTranslation } from '../i18n/useTranslation';
import { usePtyAttachWarm, type PtyAttachState } from '../terminal/usePtyAttach.warm';
import { useAtBottom } from '../terminal/useAtBottom';
import { getActiveEntry } from '../terminal/xtermWarmRegistry';
import { terminalCopy, terminalPaste } from '../terminal/paste';
import { ScrollToBottomButton } from './ScrollToBottomButton';
import { useStore } from '../stores/store';
import {
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
} from '../stores/slices/types';

// TerminalPane is the host shell for the per-session warm xterm view.
// The registry (`src/terminal/xtermWarmRegistry.ts`) owns the actual
// Terminal instances — this component just provides the reparent target
// host div, overlays (Error / Exit), and wires right-click
// copy/paste. Per-session warm state means switching sessions reparents
// the wrapper rather than tearing down xterm.
//
// The host div carries [data-terminal-host] and [data-active-sid={sessionId}]
// so e2e probes can locate the active terminal deterministically.

type Props = {
  sessionId: string;
  cwd: string;
};

export function TerminalPane({ sessionId, cwd }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const { t } = useTranslation();

  const { state, onRetry } = usePtyAttachWarm(sessionId, cwd, hostRef);
  // `atBottom` is intentionally unused — the button is always visible
  // while ready (see ScrollToBottomButton). We keep the hook subscribed
  // so the detection logic (and its tests) stays live for future use.
  const { scrollToBottom } = useAtBottom(sessionId);

  // Ctrl+MouseWheel zoom for the terminal font size. We attach via
  // useEffect rather than React's `onWheel` prop because React synthesizes
  // wheel events as passive on the document root (cannot preventDefault),
  // and we need to suppress both the page-zoom default AND xterm's own
  // wheel-to-scroll handler when Ctrl is held. Capture phase + non-passive
  // is the only way that works across Chromium versions.
  //
  // The store action is no-op on equal value (clamped 8–32), and the
  // app-effect subscriber dedupes and dispatches `applyTerminalFontSize`
  // to the registry. We RAF-coalesce so a fast scroll fires one resize
  // per frame instead of per wheel tick.
  //
  // Mouse-anchored scroll: before changing the font, we sample the
  // logical line under the cursor (anchorLine = viewportY + offsetY/cellH).
  // After the registry writes `term.options.fontSize` (synchronous reflow
  // via the zustand subscriber), we read the new cell height and
  // scrollToLine so the same anchorLine stays at the same screen-Y. This
  // is what gives WT / iTerm2 their "zoom around the pointer" feel.
  // Uses xterm internals (`_core._renderService.dimensions.css.cell`) —
  // best-effort, wrapped in try/catch; on any failure we skip the
  // re-anchor and the user still gets correct zoom, just without the
  // pointer-fixing.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let raf = 0;
    let pendingDelta = 0;
    let pendingClientY = 0;
    const readCellHeight = (term: unknown): number | null => {
      try {
        const core = (term as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { height?: number } } } } } })._core;
        const h = core?._renderService?.dimensions?.css?.cell?.height;
        return typeof h === 'number' && h > 0 ? h : null;
      } catch {
        return null;
      }
    };
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return;
      if (e.deltaY === 0) return;
      e.preventDefault();
      e.stopPropagation();
      // Wheel-up (deltaY < 0) zooms IN (larger font); wheel-down zooms
      // out. Step by 1 per wheel notch regardless of |deltaY| — touchpad
      // pinch gestures (typically large continuous deltaY) still feel
      // responsive because we step in the direction's sign only.
      pendingDelta += e.deltaY < 0 ? 1 : -1;
      pendingClientY = e.clientY;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const delta = pendingDelta;
        const clientY = pendingClientY;
        pendingDelta = 0;
        if (delta === 0) return;
        const cur = useStore.getState().terminalFontSizePx;
        const next = Math.max(
          TERMINAL_FONT_SIZE_MIN,
          Math.min(TERMINAL_FONT_SIZE_MAX, cur + delta),
        );
        if (next === cur) return;
        // Capture anchor before dispatch (cellH still reflects old font).
        const active = getActiveEntry();
        const term = active?.term;
        let anchorLine: number | null = null;
        let anchorScreenRow: number | null = null;
        if (term) {
          try {
            const rect = host.getBoundingClientRect();
            const offsetY = clientY - rect.top;
            const cellHOld = readCellHeight(term);
            const buf = term.buffer.active;
            if (cellHOld != null && offsetY >= 0 && offsetY <= rect.height) {
              anchorScreenRow = Math.floor(offsetY / cellHOld);
              anchorLine = buf.viewportY + anchorScreenRow;
            }
          } catch {
            /* anchor capture best-effort */
          }
        }
        useStore.getState().setTerminalFontSizePx(next);
        // After dispatch, the registry has synchronously written
        // term.options.fontSize and called fit.fit(); cell metrics now
        // reflect the new font. Reposition so anchorLine stays under
        // the cursor (modulo sub-cell rounding).
        if (term && anchorLine != null && anchorScreenRow != null) {
          try {
            const cellHNew = readCellHeight(term);
            const buf = term.buffer.active;
            if (cellHNew != null) {
              const desiredViewportY = anchorLine - anchorScreenRow;
              const clamped = Math.max(
                0,
                Math.min(buf.baseY, desiredViewportY),
              );
              (term as unknown as {
                scrollToLine?: (n: number) => void;
              }).scrollToLine?.(clamped);
            }
          } catch {
            /* re-anchor best-effort — skip on failure */
          }
        }
      });
    };
    host.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => {
      host.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  const onContextMenu = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        window.ccsmShell?.suppressContextMenuOnce();
      } catch {
        // best-effort
      }
      // Native CLI/terminal-emulator behaviour: right-click with selection
      // copies + clears; without selection, pastes. Routed through the
      // shared `paste` module, which operates on whichever warm entry is
      // currently active. No popover.
      const term = getActiveEntry()?.term;
      const copied = terminalCopy(term);
      if (!copied) {
        void terminalPaste(() => getActiveEntry()?.term, sessionId, 'right-click');
      }
    },
    [sessionId],
  );

  return (
    <div
      className="relative flex-1 w-full h-full bg-black ring-1 ring-inset ring-white/5"
      data-terminal-host
      data-active-sid={sessionId}
      data-ccsm-warm-xterm
      onContextMenu={onContextMenu}
    >
      {/* The registry owns the inner wrapper(s); this host div is the
          reparent target. The registry's `ensureAndShowEntry` does the
          appendChild of its per-sid wrapper directly under the host. */}
      <div ref={hostRef} className="absolute inset-0" />
      <Overlay state={state} onRetry={onRetry} t={t} />
      {state.kind === 'ready' ? (
        <ScrollToBottomButton onClick={scrollToBottom} />
      ) : null}
    </div>
  );
}

function Overlay({
  state,
  onRetry,
  t,
}: {
  state: PtyAttachState;
  onRetry: () => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  // Intentionally no overlay for `state.kind === 'attaching'`: per user
  // feedback, cold attaches should leave the pane visually unchanged for
  // the brief window before the snapshot lands rather than flashing an
  // "Attaching..." placeholder. State machine still tracks 'attaching'
  // for focus/IPC guards elsewhere.
  if (state.kind === 'error') {
    // z-10 so the overlay sits above xterm's canvas layers (the canvas
    // renderer stacks its own absolutely-positioned canvases inside the
    // host div with non-zero z-index — without an explicit z here the
    // Retry button is rendered but unclickable). select-text on the
    // message so the user can highlight + Ctrl+C the error to share
    // (e.g. "spawn_failed: ... error code:267") with support.
    return (
      <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 text-sm bg-black/80">
        <div className="text-red-400 max-w-md text-center break-words px-4 select-text">
          {state.message}
        </div>
        <button
          type="button"
          onClick={onRetry}
          className="px-3 py-1 rounded border border-neutral-700 text-neutral-200 hover:bg-neutral-800 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neutral-400"
        >
          Retry
        </button>
      </div>
    );
  }
  if (state.kind === 'exit') {
    // Two-tone overlay: clean exits get a neutral/dim background (user
    // typed /exit on purpose, no alarm); crashed exits keep the red
    // treatment so the user notices. Copy is locked in i18n —
    // `terminal.exitedClean` reassures, `terminal.exitedCrash` explicitly
    // disclaims ccsm involvement and points at the on-disk transcript so
    // the user knows their work is safe. z-10 + select-text rationale
    // matches the `error` overlay above.
    return (
      <div
        data-pty-exit-kind={state.exitKind}
        className={
          state.exitKind === 'crashed'
            ? 'absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 text-sm bg-black/80'
            : 'absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 text-sm bg-neutral-900/85'
        }
      >
        <div
          className={
            state.exitKind === 'crashed'
              ? 'text-state-error-text max-w-md text-center break-words px-4 select-text'
              : 'text-neutral-300 max-w-md text-center break-words px-4 select-text'
          }
        >
          {state.exitKind === 'crashed'
            ? t('terminal.exitedCrash', { detail: state.detail })
            : t('terminal.exitedClean')}
        </div>
        <button
          type="button"
          onClick={onRetry}
          className="px-3 py-1 rounded border border-neutral-700 text-neutral-200 hover:bg-neutral-800 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neutral-400"
        >
          {t('terminal.exitedRetry')}
        </button>
      </div>
    );
  }
  return null;
}

export default TerminalPane;
