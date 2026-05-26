import { useCallback, useEffect, useRef, type MouseEvent } from 'react';
import '@xterm/xterm/css/xterm.css';
import { useTranslation } from '../i18n/useTranslation';
import { usePtyAttach, type PtyAttachState } from '../terminal/usePtyAttach';
import { useAtBottom } from '../terminal/useAtBottom';
import { getActiveShell } from '../terminal/shellRegistry';
import { terminalCopy, terminalPaste } from '../terminal/paste';
import { ScrollToBottomButton } from './ScrollToBottomButton';
import { useStore } from '../stores/store';
import {
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
} from '../stores/slices/types';

// TerminalPane is the host for the per-session shell rendered by
// `src/terminal/shellRegistry.ts`. The registry owns the Terminal
// instances; this component renders the host div (shell wrappers attach
// here), the "preparing" mask (shown during cold-start), and the
// Error/Exit overlays.
//
// Attach UX model (see `docs/attach-redesign.html`):
//   - state.kind === 'cold-starting' → mask is visible. The shell is
//     being built under the host but hidden behind the mask. When
//     createShell resolves, state flips to 'ready' and the mask
//     disappears in the same React commit.
//   - state.kind === 'ready' → mask is hidden. The active shell's
//     wrapper is at the top of the z-stack under the host.
//   - state.kind === 'exit' / 'error' → overlay is visible above the
//     terminal (z-10), with a Retry button.

type Props = {
  sessionId: string;
  cwd: string;
};

export function TerminalPane({ sessionId, cwd }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const { t } = useTranslation();

  const { state, onRetry } = usePtyAttach(sessionId, cwd, hostRef);
  const { scrollToBottom } = useAtBottom(sessionId);

  // Ctrl+MouseWheel zoom for the terminal font size.
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
        const active = getActiveShell();
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
            /* re-anchor best-effort */
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
        /* best-effort */
      }
      const term = getActiveShell()?.term;
      const copied = terminalCopy(term);
      if (!copied) {
        void terminalPaste(() => getActiveShell()?.term, sessionId, 'right-click');
      }
    },
    [sessionId],
  );

  return (
    <div
      className="relative flex-1 w-full h-full bg-black ring-1 ring-inset ring-white/5"
      data-terminal-host
      data-active-sid={sessionId}
      data-ccsm-attach-state={state.kind}
      onContextMenu={onContextMenu}
    >
      {/* The registry's shell wrappers attach as children of this inner
          host div. Each wrapper is `absolute inset-0`; visibility flips
          via `display` + `z-index`. The mask below sits over them
          during cold start. */}
      <div ref={hostRef} data-ccsm-shell-host className="absolute inset-0" />
      {state.kind === 'cold-starting' ? (
        <ColdStartMask t={t} />
      ) : null}
      <Overlay state={state} onRetry={onRetry} t={t} />
      {state.kind === 'ready' ? (
        <ScrollToBottomButton onClick={scrollToBottom} />
      ) : null}
    </div>
  );
}

// "Preparing..." mask shown during cold start. z-5 (above the shell
// wrappers which use z-index 0/1, below the error/exit overlays at z-10).
function ColdStartMask({
  t,
}: {
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  return (
    <div
      data-ccsm-cold-mask
      className="absolute inset-0 z-[5] flex items-center justify-center text-sm text-neutral-400 bg-black"
    >
      <div className="flex items-center gap-2">
        <span className="inline-block h-2 w-2 rounded-full bg-neutral-500 animate-pulse" />
        <span>{t('terminal.coldStart.preparing')}</span>
      </div>
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
  if (state.kind === 'error') {
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
