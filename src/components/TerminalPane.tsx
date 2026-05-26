import { useCallback, useEffect, useRef, type MouseEvent } from 'react';
import '@xterm/xterm/css/xterm.css';
import { useTranslation } from '../i18n/useTranslation';
import { usePtyAttachShell, type PtyAttachState } from '../terminal/usePtyAttachShell';
import { useAtBottom } from '../terminal/useAtBottom';
import { getTopShell } from '../terminal/shellRegistry';
import { terminalCopy, terminalPaste } from '../terminal/paste';
import { ScrollToBottomButton } from './ScrollToBottomButton';
import { useStore } from '../stores/store';
import {
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
} from '../stores/slices/types';

// TerminalPane is the host shell for the per-session shellRegistry view.
// shellRegistry owns one xterm Terminal + wrapper + mask per visited sid;
// switching is a z-stack flip on this host's children. Cold start is
// gated behind a black mask div per shell. See `docs/attach-redesign.html`.
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

  const { state, onRetry } = usePtyAttachShell(sessionId, cwd, hostRef);
  const { scrollToBottom } = useAtBottom(sessionId);

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
        const shell = getTopShell();
        const term = shell?.term;
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
      const term = getTopShell()?.term;
      const copied = terminalCopy(term);
      if (!copied) {
        void terminalPaste(() => getTopShell()?.term, sessionId, 'right-click');
      }
    },
    [sessionId],
  );

  return (
    <div
      className="relative flex-1 w-full h-full bg-black ring-1 ring-inset ring-white/5"
      data-terminal-host
      data-active-sid={sessionId}
      data-ccsm-shell-host
      onContextMenu={onContextMenu}
    >
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
