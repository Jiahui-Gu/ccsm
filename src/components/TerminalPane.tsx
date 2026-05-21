import { useCallback, useRef, type MouseEvent } from 'react';
import '@xterm/xterm/css/xterm.css';
import { useTranslation } from '../i18n/useTranslation';
import { useXtermSingleton } from '../terminal/useXtermSingleton';
import { useTerminalResize } from '../terminal/useTerminalResize';
import { usePtyAttach, type PtyAttachState } from '../terminal/usePtyAttach';
import { useAtBottom } from '../terminal/useAtBottom';
import { terminalCopy, terminalPaste } from '../terminal/xtermSingleton';
import { ScrollToBottomButton } from './ScrollToBottomButton';

// TerminalPane is the host shell for the singleton xterm view. The three
// concerns it used to mash together — singleton bring-up, PTY lifecycle,
// container resize — now live in dedicated hooks under src/terminal/.
// This file is the host div + ExitState/ErrorState overlays + composition
// of those three hooks. See:
//   - src/terminal/xtermSingleton.ts    (module-singleton state + ensureTerminal)
//   - src/terminal/useXtermSingleton.ts (mount-once bring-up)
//   - src/terminal/usePtyAttach.ts      (attach/detach/snapshot/subscribe + exit)
//   - src/terminal/useTerminalResize.ts (ResizeObserver + fit)
//
// The host div carries [data-terminal-host] and [data-active-sid={sessionId}]
// so the e2e probes (PR-7) can locate the active terminal deterministically.

type Props = {
  sessionId: string;
  cwd: string;
};

export function TerminalPane({ sessionId, cwd }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const { t } = useTranslation();

  useXtermSingleton(hostRef);
  useTerminalResize(hostRef);
  const { state, onRetry } = usePtyAttach(sessionId, cwd);
  // `atBottom` is intentionally unused — the button is always visible while
  // ready (see ScrollToBottomButton). We keep the hook subscribed so the
  // detection logic (and its tests) stay live for future use.
  const { scrollToBottom } = useAtBottom(sessionId);

  // Native CLI / terminal-emulator right-click behavior. Mirrors Windows
  // Terminal / gnome-terminal: right-click with selection → copy (+ clear
  // for visual feedback); right-click with no selection → paste. No
  // popover, ever. The native context menu installed in
  // `electron/window/createWindow.ts` would race on top by default —
  // `ccsmShell.suppressContextMenuOnce()` tells main to skip the next
  // popup for this WebContents (DOM `preventDefault()` alone does NOT
  // cancel Electron's main-process `context-menu` event). Optional chain
  // on the bridge because tests / e2e probes may not install it.
  const onContextMenu = useCallback((e: MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      window.ccsmShell?.suppressContextMenuOnce();
    } catch {
      // best-effort — falling through to inline copy/paste still works,
      // user just sees the native menu race briefly.
    }
    const copied = terminalCopy();
    if (!copied) terminalPaste();
  }, []);

  return (
    <div
      className="relative flex-1 w-full h-full bg-black ring-1 ring-inset ring-white/5"
      data-terminal-host
      data-active-sid={sessionId}
      onContextMenu={onContextMenu}
    >
      <div ref={hostRef} className="absolute inset-0" />
      <Overlay state={state} onRetry={onRetry} t={t} />
      {/* Hide the jump-to-bottom affordance while an overlay (attaching /
          error / exit) is up — those cover the viewport and the button
          would be meaningless. While ready, the button is always visible:
          clicking it when already at bottom is a no-op (xterm's
          scrollToBottom is idempotent), and conditional visibility based
          on the atBottom signal proved flaky in practice. */}
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
  if (state.kind === 'attaching') {
    return (
      <div className="absolute inset-0 z-10 flex items-center justify-center text-neutral-400 text-sm pointer-events-none">
        Attaching...
      </div>
    );
  }
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
